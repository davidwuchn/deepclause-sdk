"""Context module for the Arguably library.

This module contains the _Context singleton class that manages the global
state and configuration of command-line parsing, including command registration,
argument parsing, type conversion, and help generation.
"""

import argparse
import asyncio
import enum
import inspect
import math
import sys
from argparse import HelpFormatter
from contextlib import contextmanager
from dataclasses import dataclass, field
from io import StringIO
from typing import (
    Any,
    Callable,
    Dict,
    Iterator,
    List,
    Optional,
    Set,
    Tuple,
    Type,
    TextIO,
    Union,
    cast,
)
from typing import get_origin, get_args

from arguably._argparse_extensions import FlagAction, ListTupleBuilderAction, ListTupleBuilderModifier
from arguably._commands import (
    Command,
    CommandArg,
    CommandDecoratorInfo,
    CommandArgModifier,
    InputMethod,
    NoDefault,
    SubtypeDecoratorInfo,
)
from arguably._modifiers import (
    CountedModifier,
    RequiredModifier,
    ListModifier,
    TupleModifier,
    MissingArgDefaultModifier,
    HandlerModifier,
    BuilderModifier,
)
from arguably._util import (
    ArguablyException,
    ArguablyWarning,
    EnumFlagInfo,
    NoDefault as UtilNoDefault,
    camel_case_to_kebab_case,
    get_ancestors,
    get_enum_member_docs,
    info_for_flags,
    is_async_callable,
    normalize_action_input,
    normalize_name,
    parse_short_and_long_name,
    warn,
)


@dataclass
class _ContextOptions:
    """Stores configuration options for _Context."""

    name: Optional[str] = None
    always_subcommand: bool = False
    version_flag: Union[bool, Tuple[str], Tuple[str, str]] = False
    strict: bool = True
    show_defaults: bool = True
    show_types: bool = True
    max_description_offset: int = 60
    max_width: int = 120
    command_metavar: str = "command"
    output: Optional[TextIO] = None


class _Context:
    """Singleton, used for storing arguably state."""

    def __init__(self) -> None:
        self._options: _ContextOptions = None  # type: ignore[assignment]
        self._extra_argparser_options: Dict[str, Any] = None  # type: ignore[assignment]

        # Info for all invocations of `@arguably.command`
        self._command_decorator_info: List[CommandDecoratorInfo] = list()

        # Info for all invocations of `@arguably.subtype`
        self._subtype_init_info: List[SubtypeDecoratorInfo] = list()

        # Stores mapping from normalized names for an enum type to an enum value
        self._enum_mapping: Dict[Type[enum.Enum], Dict[str, enum.Enum]] = dict()

        # Stores which flag arguments have had their default value cleared
        self._enum_flag_default_cleared: Set[Tuple[argparse.ArgumentParser, str]] = set()

        # Are we currently calling the targeted command (or just an ancestor?)
        self._is_calling_target = True

        # Used for handling `error()`, keeps a reference to the parser for the current command
        self._current_parser: Optional[argparse.ArgumentParser] = None

        # These are really only set and used in the run() method
        self._commands: Dict[str, Command] = dict()
        self._command_aliases: Dict[str, str] = dict()
        self._parsers: Dict[str, argparse.ArgumentParser] = dict()
        self._subparsers: Dict[str, Any] = dict()

        # Track whether single command is used without subparser
        self._single_command_no_subparser: bool = False

    def reset(self) -> None:
        """Resets all context state to initial values."""
        self.__dict__.clear()
        self.__init__()

    # ------------------------------------------------------------------ #
    #  Public API                                                         #
    # ------------------------------------------------------------------ #

    def add_command(self, **kwargs: Any) -> None:
        """Invoked by `@arguably.command`, saves info about a command."""
        info = CommandDecoratorInfo(**kwargs)
        self._command_decorator_info.append(info)

    def add_subtype(self, **kwargs: Any) -> None:
        """Invoked by `@arguably.subtype`, saves info about how to construct a type."""
        type_ = SubtypeDecoratorInfo(**kwargs)
        self._subtype_init_info.append(type_)

    def find_subtype(self, func_arg_type: type) -> List[SubtypeDecoratorInfo]:
        """Find all subtypes that are subclasses of the given type."""
        return [bi for bi in self._subtype_init_info if issubclass(bi.type_, func_arg_type)]

    def is_target(self) -> bool:
        """Returns `True` if the targeted command is being executed."""
        return self._is_calling_target

    def check_and_set_enum_flag_default_status(
        self, parser: argparse.ArgumentParser, cli_arg_name: str
    ) -> bool:
        """Checks and sets the default status of an enum flag.

        Returns True if already cleared (subsequent flag), False on first flag.
        """
        key = (parser, cli_arg_name)
        if key in self._enum_flag_default_cleared:
            return True
        self._enum_flag_default_cleared.add(key)
        return False

    def set_up_enum(
        self, enum_type: Type[enum.Enum], members: Optional[List[enum.Enum]] = None
    ) -> Dict[str, enum.Enum]:
        """Sets up an enum type, mapping normalized names -> enum values."""
        if enum_type in self._enum_mapping:
            return self._enum_mapping[enum_type]

        mapping: Dict[str, enum.Enum] = {}
        targets = members if members is not None else list(enum_type)
        for member in targets:
            normalized = normalize_name(member.name, spaces=False)
            mapping[normalized] = member
            mapping[member.name] = member
            if isinstance(member.value, str):
                mapping[member.value] = member
                mapping[member.value.lower()] = member

        self._enum_mapping[enum_type] = mapping
        return mapping

    def get_enum_mapping(self, enum_type: Type[enum.Enum]) -> Dict[str, enum.Enum]:
        """Get the enum mapping for a given enum type."""
        assert enum_type in self._enum_mapping
        return self._enum_mapping[enum_type]

    @contextmanager
    def current_parser(self, parser: argparse.ArgumentParser) -> Iterator[None]:
        """Manages the current parser."""
        old_parser = self._current_parser
        self._current_parser = parser
        try:
            yield
        finally:
            self._current_parser = old_parser

    def error(self, message: str) -> None:
        """Prints an error message and exits."""
        if self._current_parser is not None:
            self._current_parser.error(message)
        else:
            print(f"Error: {message}", file=sys.stderr)
            sys.exit(1)

    # ------------------------------------------------------------------ #
    #  The main `run()` entry-point                                       #
    # ------------------------------------------------------------------ #

    def run(
        self,
        name: Optional[str] = None,
        always_subcommand: bool = False,
        version_flag: Union[bool, Tuple[str], Tuple[str, str]] = False,
        strict: bool = True,
        show_defaults: bool = True,
        show_types: bool = True,
        max_description_offset: int = 60,
        max_width: int = 120,
        command_metavar: str = "command",
        output: Optional[TextIO] = None,
    ) -> Any:
        """Set up the argument parser, parse argv, and run the appropriate command(s)."""
        # Preserve decorator info
        saved_commands = list(self._command_decorator_info)
        saved_subtypes = list(self._subtype_init_info)

        # Fresh state
        self.reset()
        self._command_decorator_info = saved_commands
        self._subtype_init_info = saved_subtypes
        self._single_command_no_subparser = False

        # Options
        self._options = _ContextOptions(
            name=name,
            always_subcommand=always_subcommand,
            version_flag=version_flag,
            strict=strict,
            show_defaults=show_defaults,
            show_types=show_types,
            max_description_offset=max_description_offset,
            max_width=max_width,
            command_metavar=command_metavar,
            output=output,
        )
        self._extra_argparser_options = {"formatter_class": self._formatter}

        # Build the command tree
        self._build_command_tree(always_subcommand)

        # Parse and execute
        return self._parse_and_execute(name, output)

    # ------------------------------------------------------------------ #
    #  Internal helpers                                                   #
    # ------------------------------------------------------------------ #

    # -- Formatter ----------------------------------------------------- #

    def _formatter(self, prog: str) -> HelpFormatter:
        """HelpFormatter for argparse."""
        return HelpFormatter(
            prog,
            max_help_position=getattr(self._options, "max_description_offset", 60),
            width=getattr(self._options, "max_width", 120),
        )

    # -- Soft failure -------------------------------------------------- #

    def _soft_failure(self, msg: str, function: Optional[Callable] = None) -> None:
        """Handles a soft failure."""
        if getattr(self._options, "strict", True):
            raise ArguablyException(msg)
        warn(msg, function)

    # -- Enum conversion helper ---------------------------------------- #

    def _convert_enum(self, enum_type: Type[enum.Enum], value: str) -> enum.Enum:
        mapping = self.get_enum_mapping(enum_type)
        if value in mapping:
            return mapping[value]
        if value.lower() in mapping:
            return mapping[value.lower()]
        try:
            return enum_type[value]
        except KeyError:
            pass
        for member in enum_type:
            if str(member.value) == value:
                return member
        raise ValueError(
            f"Invalid value '{value}' for enum {enum_type.__name__}. "
            f"Valid values: {[m.name for m in enum_type]}"
        )

    # -- CLI name helpers ---------------------------------------------- #

    def _get_cli_names(self, arg_: CommandArg) -> List[str]:
        if arg_.short_name and arg_.long_name:
            return [arg_.short_name, arg_.long_name]
        elif arg_.long_name:
            return [arg_.long_name]
        return [f"--{arg_.cli_arg_name}"]

    def _get_type_string(self, value_type: type) -> Optional[str]:
        for t, s in [(str, "str"), (int, "int"), (float, "float"), (bool, "bool")]:
            if value_type is t:
                return s
        if hasattr(value_type, "__name__"):
            return value_type.__name__
        return None

    # -- Type-handling setup ------------------------------------------- #

    def _set_up_type_handling(self, arg_: CommandArg, kwargs_dict: Dict[str, Any]) -> None:
        """Set up type-specific handling for an argument."""
        if "type" in kwargs_dict or "action" in kwargs_dict:
            return

        value_type = arg_.value_type
        origin = get_origin(value_type)

        # Bool
        try:
            is_bool_type = issubclass(value_type, bool)
        except TypeError:
            is_bool_type = False
        if is_bool_type:
            # If modifier already set nargs/const (e.g., missing modifier), use a custom approach
            # store_const doesn't support nargs="?", so we use store_const with const value
            if "const" in kwargs_dict:
                missing_val = kwargs_dict.pop("const", True)
                nargs_val = kwargs_dict.pop("nargs", None)
                # Use two flags: --flag sets const, --flag value sets the value
                # Actually for nargs="?": --flag alone uses const, --flag VALUE uses value
                # We'll use store_true + custom default
                kwargs_dict["action"] = "store_true"
                # Override the default behavior: when --verbose is present, use const value
                kwargs_dict.setdefault("default", False)
            elif "nargs" not in kwargs_dict:
                kwargs_dict["action"] = "store_true"
            return

        # list[T]
        if origin in (list, List):
            type_args = get_args(value_type)
            if type_args:
                kwargs_dict["type"] = type_args[0]
            if "nargs" not in kwargs_dict:
                kwargs_dict["nargs"] = "*"
            return

        # tuple[T, ...]
        if origin in (tuple, Tuple):
            type_args = get_args(value_type)
            if type_args:
                kwargs_dict["action"] = ListTupleBuilderAction
                kwargs_dict["command_arg"] = arg_
                # Pass tuple types via custom key to avoid argparse validating it as callable
                kwargs_dict["_arguably_tuple_types"] = type_args
            return

        # Enum.Flag
        try:
            is_flag = issubclass(value_type, enum.Flag)
        except TypeError:
            is_flag = False
        if is_flag:
            kwargs_dict["action"] = "store"
            kwargs_dict["type"] = value_type
            return

        # Regular Enum
        try:
            is_enum = issubclass(value_type, enum.Enum)
        except TypeError:
            is_enum = False
        if is_enum:
            self.set_up_enum(value_type)
            enum_values = list(self.get_enum_mapping(value_type).values())
            seen = set()
            deduped = []
            for e in enum_values:
                if e not in seen:
                    seen.add(e)
                    deduped.append(e)
            kwargs_dict["choices"] = deduped
            et = value_type
            kwargs_dict["type"] = lambda s, et=et: self._convert_enum(et, s)
            return

        # Optional[inner]
        if origin is Union:
            type_args = get_args(value_type)
            non_none = [t for t in type_args if t is not type(None)]
            if len(non_none) == 1:
                inner_type = non_none[0]
                if callable(inner_type) and inner_type not in (str,):
                    kwargs_dict["type"] = inner_type
                return

        # pathlib.Path
        try:
            from pathlib import Path
            if value_type is Path:
                kwargs_dict["type"] = Path
                return
        except ImportError:
            pass

        # Basic types that argparse needs explicit converters for
        if value_type is int:
            kwargs_dict["type"] = int
            return
        if value_type is float:
            kwargs_dict["type"] = float
            return
        if value_type is str:
            kwargs_dict["type"] = str
            return

        # Custom callable types
        try:
            if callable(value_type):
                kwargs_dict["type"] = value_type
        except Exception:
            pass

    # -- Default-value helper ------------------------------------------ #

    def _set_default_value(self, arg_: CommandArg, kwargs_dict: Dict[str, Any]) -> None:
        """Set the default value for an argument."""
        if isinstance(arg_.default, type(UtilNoDefault)):
            try:
                is_bool_type = issubclass(arg_.value_type, bool)
            except TypeError:
                is_bool_type = False
            if is_bool_type:
                kwargs_dict.setdefault("default", False)
            return

        action = kwargs_dict.get("action")
        if action in ("store_true", "store_false", "count"):
            if "default" not in kwargs_dict:
                if action == "store_true":
                    kwargs_dict["default"] = False
                elif action == "store_false":
                    kwargs_dict["default"] = True
                elif action == "count":
                    kwargs_dict["default"] = 0
            return

        nargs = kwargs_dict.get("nargs")
        action = kwargs_dict.get("action")
        if nargs in ("*", "+"):
            kwargs_dict.setdefault("default", arg_.default if arg_.default is not None else [])
        elif action in (ListTupleBuilderAction, ListTupleBuilderModifier):
            # Tuple/list builder actions need a list default
            if not isinstance(arg_.default, (list, tuple)):
                kwargs_dict["default"] = []
            else:
                kwargs_dict["default"] = arg_.default
        else:
            kwargs_dict["default"] = arg_.default

    # -- Validation ---------------------------------------------------- #

    def _validate_args(self, cmd: Command, is_root_cmd: bool) -> None:
        """Validates all arguments for a command."""
        for arg_ in cmd.args:
            for modifier in arg_.modifiers:
                try:
                    modifier.check_valid(arg_.value_type, arg_, cmd.name)
                except ArguablyException:
                    raise
                except Exception as e:
                    raise ArguablyException(
                        f"Modifier validation failed for `{arg_.func_arg_name}` "
                        f"in `{cmd.name}`: {e}"
                    )

            try:
                is_bool_type = issubclass(arg_.value_type, bool)
            except TypeError:
                is_bool_type = False
            if is_bool_type and arg_.input_method.is_positional:
                raise ArguablyException(
                    f"Boolean parameter `{arg_.func_arg_name}` in `{cmd.name}` "
                    f"cannot be positional"
                )

    # -- Argument setup ------------------------------------------------ #

    def _set_up_args(self, cmd: Command) -> None:
        """Adds all arguments to the parser for a given command."""
        if cmd.name not in self._parsers:
            return

        parser = self._parsers[cmd.name]

        for arg_ in cmd.args:
            kwargs_dict: Dict[str, Any] = {}
            cli_names = self._get_cli_names(arg_)

            # Apply modifiers
            for modifier in arg_.modifiers:
                modifier.modify_arg_dict(cmd, arg_, kwargs_dict)

            # Type handling
            self._set_up_type_handling(arg_, kwargs_dict)

            # Defaults
            self._set_default_value(arg_, kwargs_dict)

            # Description / help text
            desc_parts = []
            if arg_.description:
                desc_parts.append(arg_.description)

            if getattr(self._options, "show_types", True):
                ts = self._get_type_string(arg_.value_type)
                if ts:
                    desc_parts.append(f"[type: {ts}]")

            if getattr(self._options, "show_defaults", True) and not isinstance(arg_.default, type(UtilNoDefault)):
                desc_parts.append(f"default: {arg_.default}")

            kwargs_dict.setdefault("help", " ".join(desc_parts) if desc_parts else "")

            # Add to parser
            # Pop keys that are custom and should only go to the action's __init__
            custom_keys = {"command_arg", "_arguably_tuple_types"}
            action_kwargs = {k: kwargs_dict.pop(k) for k in custom_keys if k in kwargs_dict}

            if arg_.input_method.is_positional:
                if "nargs" not in kwargs_dict:
                    kwargs_dict["nargs"] = None
                try:
                    parser.add_argument(arg_.cli_arg_name, **kwargs_dict, **action_kwargs)
                except argparse.ArgumentError as e:
                    raise ArguablyException(str(e))
            else:
                try:
                    parser.add_argument(*cli_names, **kwargs_dict, **action_kwargs)
                except argparse.ArgumentError as e:
                    raise ArguablyException(str(e))

    # -- Subparser tree ------------------------------------------------ #

    def _create_root_parser(self) -> None:
        """Create the root parser."""
        prog_name = getattr(self._options, "name", None) or (
            sys.argv[0] if sys.argv else "cli"
        )
        prog_name = prog_name.replace("\\", "/").rsplit("/", 1)[-1]
        if prog_name.endswith(".py"):
            prog_name = prog_name[:-3]

        root = argparse.ArgumentParser(prog=prog_name, formatter_class=self._formatter)
        self._parsers["__root__"] = root
        self._commands["__root__"] = None  # type: ignore

    def _build_subparser_tree(self, command_decorator_info: CommandDecoratorInfo) -> str:
        """Builds the subparser tree for a command. Returns parent name."""
        cmd = command_decorator_info.command
        cmd_name = cmd.name

        self._commands[cmd_name] = cmd
        if cmd.alias:
            self._command_aliases[cmd.alias] = cmd_name

        parts = cmd_name.split("__")

        if len(parts) == 1:
            parent_name = "__root__"
            if "__root__" not in self._parsers:
                self._create_root_parser()

            parent_parser = self._parsers["__root__"]

            # Ensure subparsers exist on root
            if "__root__" not in self._subparsers:
                sp = parent_parser.add_subparsers(
                    dest=cmd_name,
                    metavar=self._options.command_metavar,
                )
                self._subparsers["__root__"] = sp
            subparser_action = self._subparsers["__root__"]

            display_name = cmd_name
            sub = subparser_action.add_parser(
                display_name,
                help=cmd.description.split("\n")[0] if cmd.description else None,
                formatter_class=self._formatter,
            )
            self._parsers[cmd_name] = sub
        else:
            # Nested command - e.g., "git__commit" -> git/commit
            # Build chain of intermediate parsers, each added as subparser of parent
            parent_parts = parts[:-1]  # e.g., ["git"] for "git__commit"
            leaf_name = parts[-1]      # e.g., "commit"

            # Ensure root parser exists
            if "__root__" not in self._parsers:
                self._create_root_parser()

            # Build parent chain from root down
            for i in range(len(parent_parts)):
                intermediate_name = "__".join(parent_parts[:i + 1])
                display_name = parent_parts[i]
                grandparent_name = "__root__" if i == 0 else "__".join(parent_parts[:i])
                grandparent_parser = self._parsers[grandparent_name]

                # Ensure subparsers exist on grandparent
                if grandparent_name not in self._subparsers:
                    sp = grandparent_parser.add_subparsers(
                        dest=grandparent_name,
                        metavar=self._options.command_metavar,
                    )
                    self._subparsers[grandparent_name] = sp

                subparser_action = self._subparsers[grandparent_name]

                # Create the intermediate parser via add_parser (linked to parent)
                if intermediate_name not in self._parsers:
                    intermediate = subparser_action.add_parser(
                        display_name,
                        help="Group of subcommands",
                        formatter_class=self._formatter,
                    )
                    self._parsers[intermediate_name] = intermediate
                    self._commands[intermediate_name] = None  # type: ignore

            # Now add the leaf command to the last parent
            parent_cmd_name = "__".join(parent_parts)
            parent_parser = self._parsers[parent_cmd_name]

            if parent_cmd_name not in self._subparsers:
                sp = parent_parser.add_subparsers(
                    dest=cmd_name,
                    metavar=cmd.get_subcommand_metavar(self._options.command_metavar),
                )
                self._subparsers[parent_cmd_name] = sp
            subparser_action = self._subparsers[parent_cmd_name]

            sub = subparser_action.add_parser(
                leaf_name,
                help=cmd.description.split("\n")[0] if cmd.description else None,
                formatter_class=self._formatter,
            )
            self._parsers[cmd_name] = sub
            parent_name = parent_cmd_name

        # Validate & set up args
        try:
            is_root = cmd_name == "__root__"
            self._validate_args(cmd, is_root)
            self._set_up_args(cmd)
        except ArguablyException:
            if getattr(self._options, "strict", True):
                raise
            self._soft_failure(
                f"Validation failed for command `{cmd_name}`", cmd.function
            )

        return parent_name

    def _build_command_tree(self, always_subcommand: bool) -> None:
        """Build the command tree from registered commands."""
        if not self._command_decorator_info:
            self._create_root_parser()
            return

        self._create_root_parser()

        # Separate __root__ command first (it contains "__" but is special)
        root_cmd_info = None
        for info in self._command_decorator_info:
            if info.name == "__root__":
                root_cmd_info = info
                break

        top_level = [i for i in self._command_decorator_info if "__" not in i.name and i.name != "__root__"]
        nested = [i for i in self._command_decorator_info if "__" in i.name and i.name != "__root__"]

        other_top_level = top_level  # these are non-root top-level commands

        has_subcommands = len(top_level) > 1 or always_subcommand or bool(nested) or (root_cmd_info and (top_level or nested))

        if not has_subcommands and root_cmd_info is None and len(top_level) == 1:
            # Single non-root command: add args directly to root parser, no subcommand needed
            self._single_command_no_subparser = True
            info = top_level[0]
            cmd = info.command
            self._commands[cmd.name] = cmd
            if cmd.alias:
                self._command_aliases[cmd.alias] = cmd.name

            # Map root parser args directly
            self._parsers[cmd.name] = self._parsers["__root__"]

            try:
                self._validate_args(cmd, False)
                self._set_up_args(cmd)
            except ArguablyException:
                if getattr(self._options, "strict", True):
                    raise
                self._soft_failure(
                    f"Validation failed for command `{cmd.name}`", cmd.function
                )
        else:
            # Multiple commands or nested: use subparsers
            # If there's a __root__ command, add its args to the root parser
            if root_cmd_info is not None:
                root_cmd = root_cmd_info.command
                self._commands["__root__"] = root_cmd
                # Map root command to root parser
                self._parsers["__root__"].set_defaults(func=root_cmd)
                try:
                    self._validate_args(root_cmd, True)
                    self._set_up_args(root_cmd)
                except ArguablyException:
                    if getattr(self._options, "strict", True):
                        raise
                    self._soft_failure(
                        f"Validation failed for command `{root_cmd.name}`", root_cmd.function
                    )

            # Build subparser tree for non-root commands
            non_root_infos = [i for i in self._command_decorator_info if i.name != "__root__"]
            for info in non_root_infos:
                self._build_subparser_tree(info)
                if info.command.alias:
                    self._command_aliases[info.command.alias] = info.command.name

        # Version flag
        if self._options.version_flag:
            self._add_version_flag()

    def _add_version_flag(self) -> None:
        """Add version flag to root parser."""
        root = self._parsers.get("__root__")
        if root is None:
            return

        vf = self._options.version_flag
        if vf is True:
            flag_args = ("--version",)
        elif isinstance(vf, tuple):
            flag_args = vf
        else:
            return

        version_str = None
        try:
            frame = inspect.currentframe()
            while frame:
                if "__version__" in frame.f_globals:
                    version_str = frame.f_globals["__version__"]
                    break
                frame = frame.f_back
        except Exception:
            pass

        if version_str is None:
            try:
                from arguably import __version__
                version_str = __version__
            except ImportError:
                version_str = "0.0.0"

        root.add_argument(
            *flag_args,
            action="version",
            version=f"%(prog)s {version_str}",
        )

    # -- Parse & execute ----------------------------------------------- #

    def _find_target_command(self, parsed_dict: Dict[str, Any]) -> Optional[Command]:
        """Find the target command from parsed arguments."""
        # For single command without subparser, just use that command
        if self._single_command_no_subparser:
            for cmd_name, cmd in self._commands.items():
                if cmd is not None:
                    return cmd

        # Check for subcommand dest values
        for key, value in parsed_dict.items():
            if isinstance(value, str) and value in self._commands:
                cmd = self._commands[value]
                if cmd is not None:
                    return cmd

        # Fallback: find first command whose args appear in parsed_dict
        for cmd_name, cmd in self._commands.items():
            if cmd is None:
                continue
            for arg in cmd.args:
                if arg.cli_arg_name in parsed_dict:
                    return cmd

        return None

    def _parse_and_execute(
        self, name: Optional[str], output: Optional[TextIO]
    ) -> Any:
        """Parse arguments and execute the appropriate command."""
        root = self._parsers.get("__root__")
        if root is None:
            return None

        if output is not None:
            root._print_message = lambda msg, file=None: output.write(msg)

        try:
            parsed_args = root.parse_args()
        except SystemExit:
            raise

        parsed_dict = vars(parsed_args)

        target = self._find_target_command(parsed_dict)

        if target is None:
            root_cmd = self._commands.get("__root__")
            if root_cmd is not None:
                self._is_calling_target = True
                with self.current_parser(root):
                    return root_cmd.call(parsed_dict)
            return None

        self._is_calling_target = True
        with self.current_parser(root):
            return target.call(parsed_dict)

    # -- Subtype helpers ----------------------------------------------- #

    def _build_subtype(
        self,
        parent_func_arg_name: str,
        subtype_info: SubtypeDecoratorInfo,
        build_kwargs: Dict[str, Any],
    ) -> Any:
        """Builds a subtype instance."""
        try:
            if subtype_info.factory is not None:
                return subtype_info.factory(**build_kwargs)
            return subtype_info.type_(**build_kwargs)
        except TypeError as e:
            raise ArguablyException(
                f"Failed to build subtype `{subtype_info.alias}` for "
                f"`{parent_func_arg_name}`: {e}"
            )

    def resolve_subtype(
        self,
        func_arg_name: str,
        arg_value_type: type,
        subtype_: Optional[str],
        build_kwargs: Dict[str, Any],
    ) -> Any:
        """Resolves and builds a subtype."""
        matching = self.find_subtype(arg_value_type)

        if not matching:
            raise ArguablyException(
                f"No subtypes registered for `{arg_value_type.__name__}` "
                f"in arg `{func_arg_name}`"
            )

        if subtype_ is not None:
            for st in matching:
                if st.alias == subtype_:
                    return self._build_subtype(func_arg_name, st, build_kwargs)
            raise ArguablyException(
                f"Unknown subtype `{subtype_}` for `{func_arg_name}`. "
                f"Available: {[s.alias for s in matching]}"
            )
        elif len(matching) == 1:
            return self._build_subtype(func_arg_name, matching[0], build_kwargs)
        else:
            raise ArguablyException(
                f"Multiple subtypes for `{arg_value_type.__name__}` in `{func_arg_name}`. "
                f"Specify one: {[s.alias for s in matching]}"
            )


# ------------------------------------------------------------------ #
#  Global singleton                                                   #
# ------------------------------------------------------------------ #
context = _Context()
