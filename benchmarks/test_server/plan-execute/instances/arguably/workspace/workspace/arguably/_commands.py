"""Command and argument data classes for the Arguably library."""

import inspect
import sys
from abc import ABC
from dataclasses import dataclass, field
from enum import Enum
from typing import (
    Any,
    Callable,
    Dict,
    List,
    Optional,
    Set,
    Tuple,
    Type,
    Union,
)

from arguably._util import (
    ArguablyException,
    InputMethod,
    NoDefault,
)
from typing import get_origin, get_args, Annotated, Tuple


def _origin_is_tuple(value_type: type) -> bool:
    """Check if value_type is a tuple type."""
    try:
        o = get_origin(value_type)
        return o is tuple or o is Tuple
    except Exception:
        return False


def origin_is_annotated(value_type: type) -> bool:
    """Check if value_type is an Annotated type."""
    try:
        o = get_origin(value_type)
        return o is Annotated
    except Exception:
        return False


class CommandArgModifier(ABC):
    """Abstract base class for command argument modifiers."""

    def check_valid(
        self, value_type: type, param: inspect.Parameter, function_name: str
    ) -> None:
        """Checks if the modifier is valid for the given parameter.

        Args:
            value_type: The type of the value.
            param: The parameter to check.
            function_name: The name of the function.

        Returns:
            None.
        """
        pass

    def modify_arg_dict(
        self,
        command: "Command",
        arg_: "CommandArg",
        kwargs_dict: Dict[str, Any],
    ) -> None:
        """Modifies the kwargs passed to parser.add_argument().

        Args:
            command: The command to modify the kwargs for.
            arg_: The argument to modify the kwargs for.
            kwargs_dict: The kwargs dictionary to modify.

        Returns:
            None.
        """
        pass


@dataclass
class CommandArg:
    """Stores information about a single command-line argument."""

    func_arg_name: str
    cli_arg_name: str
    value_type: type
    input_method: InputMethod
    default: Any = NoDefault()
    description: str = ""
    modifiers: List[CommandArgModifier] = field(default_factory=list)
    metavars: Optional[List[str]] = None
    short_name: Optional[str] = None
    long_name: Optional[str] = None

    @property
    def is_positional(self) -> bool:
        """Whether this argument is positional."""
        return self.input_method.is_positional

    @property
    def is_optional(self) -> bool:
        """Whether this argument is optional."""
        return self.input_method.is_optional

    @property
    def is_required(self) -> bool:
        """Whether this argument is required (no default value)."""
        return not isinstance(self.default, type) or self.default != type(
            NoDefault()
        )

    @property
    def cli_names(self) -> List[str]:
        """List of CLI names for this argument (short and long)."""
        names: List[str] = []
        if self.short_name:
            names.append(self.short_name)
        if self.long_name:
            names.append(self.long_name)
        if not names:
            names.append(self.cli_arg_name)
        return names


@dataclass
class Command:
    """A fully processed command."""

    function: Callable
    name: str
    args: List[CommandArg]
    description: str = ""
    alias: Optional[str] = None
    add_help: bool = True

    func_arg_names: Set[str] = field(default_factory=set)
    cli_arg_map: Dict[str, CommandArg] = field(default_factory=dict)

    def __post_init__(self) -> None:
        """Initializes the Command.

        Builds the cli_arg_map and validates there are no duplicate
        CLI argument names. Raises ArguablyException on conflicts.
        """
        self.cli_arg_map = dict()
        self.func_arg_names = set()
        for arg in self.args:
            assert arg.func_arg_name not in self.func_arg_names
            self.func_arg_names.add(arg.func_arg_name)

            if arg.cli_arg_name in self.cli_arg_map:
                raise ArguablyException(
                    f"Function argument `{arg.func_arg_name}` in `{self.name}` conflicts with "
                    f"`{self.cli_arg_map[arg.cli_arg_name].func_arg_name}`, both have the CLI name `{arg.cli_arg_name}`"
                )
            self.cli_arg_map[arg.cli_arg_name] = arg

    def call(self, parsed_args: Dict[str, Any]) -> Any:
        """Filters arguments from argparse to only include the ones used by this command, then calls it.

        Args:
            parsed_args: The parsed arguments from argparse.

        Returns:
            The result of the function call.
        """
        # Build kwargs for the function call from the parsed args
        # Only include arguments that belong to this command
        kwargs: Dict[str, Any] = {}
        for arg in self.args:
            # argparse converts --foo-bar to foo_bar in namespace
            # so we need to try both the cli_arg_name and its underscore version
            cli_key = arg.cli_arg_name
            if cli_key not in parsed_args:
                # Try underscore version
                underscore_key = cli_key.replace("-", "_")
                if underscore_key in parsed_args:
                    cli_key = underscore_key
            if cli_key in parsed_args:
                val = parsed_args[cli_key]
                # Handle tuple types: ListTupleBuilderAction stores values in a list
                # If the value is a list with a single tuple/str element, extract it
                if _origin_is_tuple(arg.value_type) and isinstance(val, list):
                    if len(val) == 1:
                        val = val[0]
                kwargs[arg.func_arg_name] = val
            elif not isinstance(arg.default, type(NoDefault())):
                # Use default value
                kwargs[arg.func_arg_name] = arg.default

        # Call the function
        if inspect.iscoroutinefunction(self.function):
            import asyncio

            return asyncio.run(self.function(**kwargs))
        return self.function(**kwargs)

    def get_subcommand_metavar(self, command_metavar: str) -> str:
        """If this command has a subparser (for subcommands of its own), this can be called to generate a unique name
        for the subparser's command metavar.

        Args:
            command_metavar: The default command metavar name.

        Returns:
            A unique metavar name for this command's subparser.
        """
        if self.name == "__root__":
            return command_metavar
        return f"{self.name.replace(' ', '_')}{'_' if len(self.name) > 0 else ''}{command_metavar}"


@dataclass
class CommandDecoratorInfo:
    """Used for keeping a reference to everything marked with @arguably.command."""

    function: Callable
    alias: Optional[str] = None
    help: bool = True
    name: str = field(init=False)
    command: Command = field(init=False)

    def __post_init__(self) -> None:
        """Initializes the CommandDecoratorInfo.

        Sets the name and processes the command from the decorator info.
        """
        self.name = self.function.__name__
        self.command = self._process()

    def _process(self) -> Command:
        """Takes the decorator info and return a processed command.

        Returns:
            A processed Command.
        """
        # Derive command name from function name
        cmd_name = self.name

        # Get docstring as description
        description = ""
        if self.function.__doc__:
            description = inspect.cleandoc(self.function.__doc__)

        # Build command args from function signature
        sig = inspect.signature(self.function)
        command_args: List[CommandArg] = []

        # Get docstring parameter descriptions
        param_docs = _extract_param_docs(self.function)

        for param_name, param in sig.parameters.items():
            arg = _create_command_arg(param_name, param, param_docs.get(param_name, ""))
            if arg is not None:
                command_args.append(arg)

        return Command(
            function=self.function,
            name=cmd_name,
            args=command_args,
            description=description,
            alias=self.alias,
            add_help=self.help,
        )


def _extract_param_docs(func: Callable) -> Dict[str, str]:
    """Extract parameter descriptions from a function's docstring.

    Args:
        func: The function to extract documentation from.

    Returns:
        A dictionary mapping parameter names to their descriptions.
    """
    import docstring_parser

    docs: Dict[str, str] = {}
    if func.__doc__:
        try:
            parsed = docstring_parser.parse(func.__doc__)
            for param in parsed.params:
                docs[param.arg_name] = param.description or ""
        except (ValueError, TypeError):
            pass
    return docs


def _create_command_arg(
    param_name: str, param: inspect.Parameter, description: str
) -> Optional[CommandArg]:
    """Create a CommandArg from a function parameter.

    Args:
        param_name: The name of the parameter.
        param: The inspect.Parameter object.
        description: The parameter description from the docstring.

    Returns:
        A CommandArg or None if the parameter should be skipped.
    """
    from arguably._util import (
        NoDefault,
        InputMethod,
        camel_case_to_kebab_case,
    )

    # Skip 'self' and 'cls' parameters
    if param_name in ("self", "cls"):
        return None

    # Determine the value type
    value_type = param.annotation if param.annotation != inspect.Parameter.empty else str

    # Determine default value
    _no_default = NoDefault()  # local sentinel
    default = _no_default
    if param.default != inspect.Parameter.empty:
        default = param.default

    # Extract modifiers from Annotated[...] type annotations
    modifiers: List[CommandArgModifier] = []
    if origin_is_annotated(value_type):
        args_of_annotated = get_args(value_type)
        # First arg is the base type, rest are metadata
        if args_of_annotated:
            value_type = args_of_annotated[0]
            for meta in args_of_annotated[1:]:
                if isinstance(meta, CommandArgModifier):
                    modifiers.append(meta)

    # Determine input method based on parameter kind and default
    if param.kind == inspect.Parameter.VAR_POSITIONAL:
        # *args - variadic positional
        input_method = InputMethod.REQUIRED_POSITIONAL
        # Use the inner type from List[T] or default to str
        if hasattr(value_type, "__args__") and value_type.__args__:
            inner_type = value_type.__args__[0]
            if inner_type is not type(_no_default):
                value_type = inner_type
        else:
            value_type = str
        cli_arg_name = camel_case_to_kebab_case(param_name)
        return CommandArg(
            func_arg_name=param_name,
            cli_arg_name=cli_arg_name,
            value_type=value_type,
            input_method=input_method,
            default=default,
            description=description,
            modifiers=modifiers,
        )
    elif param.kind == inspect.Parameter.VAR_KEYWORD:
        # **kwargs - skip for now
        return None
    elif param.kind == inspect.Parameter.KEYWORD_ONLY:
        # keyword-only args become options
        cli_arg_name = camel_case_to_kebab_case(param_name)
        input_method = InputMethod.OPTION
        if default is NoDefault():
            input_method = InputMethod.OPTION
        return CommandArg(
            func_arg_name=param_name,
            cli_arg_name=cli_arg_name,
            value_type=value_type,
            input_method=input_method,
            default=default,
            description=description,
            modifiers=modifiers,
        )
    elif param.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD):
        # Bool and Enum parameters should always be options, not positional
        try:
            is_bool = issubclass(value_type, bool)
        except TypeError:
            is_bool = False
        try:
            import enum
            is_enum = issubclass(value_type, enum.Enum)
        except TypeError:
            is_enum = False
        
        if is_bool or is_enum:
            cli_arg_name = camel_case_to_kebab_case(param_name)
            # For enums without defaults, set NoDefault
            if is_enum and default is _no_default:
                pass  # keep as NoDefault
            return CommandArg(
                func_arg_name=param_name,
                cli_arg_name=cli_arg_name,
                value_type=value_type,
                input_method=InputMethod.OPTION,
                default=default if default is not _no_default else False if is_bool else _no_default,
                description=description,
                modifiers=modifiers,
            )

        # Check for tuple types - they should always be options
        try:
            from typing import get_origin
            _origin = get_origin(value_type)
            is_tuple_type = _origin is tuple or _origin is Tuple
        except (NameError, AttributeError):
            is_tuple_type = False

        if is_tuple_type:
            cli_arg_name = camel_case_to_kebab_case(param_name)
            return CommandArg(
                func_arg_name=param_name,
                cli_arg_name=cli_arg_name,
                value_type=value_type,
                input_method=InputMethod.OPTION,
                default=default,
                description=description,
                modifiers=modifiers,
            )

        # Determine if this should be a positional or option argument
        if default is _no_default:
            input_method = InputMethod.REQUIRED_POSITIONAL
        elif param.kind == inspect.Parameter.POSITIONAL_ONLY:
            # positional-only params with defaults -> optional positional
            input_method = InputMethod.OPTIONAL_POSITIONAL
        else:
            # POSITIONAL_OR_KEYWORD with default -> treat as option
            input_method = InputMethod.OPTION

        cli_arg_name = camel_case_to_kebab_case(param_name)
        return CommandArg(
            func_arg_name=param_name,
            cli_arg_name=cli_arg_name,
            value_type=value_type,
            input_method=input_method,
            default=default,
            description=description,
            modifiers=modifiers,
        )

    return None


@dataclass
class SubtypeDecoratorInfo:
    """Used for keeping a reference to everything marked with @arguably.subtype."""

    type_: type
    alias: str
    factory: Optional[Callable] = None
