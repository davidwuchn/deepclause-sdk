"""Utility functions and classes for the Arguably library."""

import asyncio
import enum
import inspect
import math
import multiprocessing
import multiprocessing.context
import os
import sys
import textwrap
import warnings
from dataclasses import dataclass
from io import StringIO
from pathlib import Path
from typing import (
    TextIO,
    Any,
    Callable,
    Dict,
    Iterator,
    List,
    Optional,
    Sequence,
    Tuple,
    Type,
    Union,
    cast,
)
from contextlib import contextmanager
import argparse
import docstring_parser


class ArguablyException(Exception):
    """Base exception for Arguably errors."""
    pass


class ArguablyWarning(UserWarning):
    """
    If strict checks are disabled through `arguably.run(strict=False)` this is emitted when a decorated function is
    incorrectly set up in some way, but arguably can continue. Will *not* be raised when a user provides incorrect input
    to the CLI.

    When `arguably` is directly invoked through `python3 -m arguably ...`, `strict=False` is always set.

    Note that this is a warning - it is used with `warnings.warn`.
    """
    pass


MANUAL = "MANUAL"
MANUALLY_MANAGED = "MANUALLY_MANAGED"


class Permissions(enum.Flag):
    """A flag enum for permissions."""
    READ = enum.auto()
    WRITE = enum.auto()
    EXECUTE = enum.auto()


class PermissionsAlt(enum.Flag):
    """An alternative flag enum for permissions."""
    R = enum.auto()
    W = enum.auto()
    X = enum.auto()


class HiBye(enum.Enum):
    """An enum for greeting/farewell."""
    HI = "hi"
    BYE = "bye"


@dataclass
class EnumFlagInfo:
    """Used similarly to _CommandArg, but for entries in an `enum.Flag`."""
    option: Union[Tuple[str], Tuple[str, str]]
    cli_arg_name: str
    value: Any
    description: str


@dataclass
class LoadAndRunResult:
    """Result from load_and_run"""
    error: Optional[str] = None
    exception: Optional[BaseException] = None


@dataclass
class ArgSpec:
    args: Tuple[Any, ...]
    kwargs: Dict[str, Any]


class NoDefault:
    """Indicator that there is no default value for a parameter. Necessary because None can be the default value."""
    pass


class InputMethod(enum.Enum):
    """Specifies how a given argument is passed in"""

    REQUIRED_POSITIONAL = 0  # usage: foo BAR
    OPTIONAL_POSITIONAL = 1  # usage: foo [BAR]
    OPTION = 2  # Examples: -F, --test_scripts, --filename foo.txt

    @property
    def is_positional(self) -> bool:
        return self in [InputMethod.REQUIRED_POSITIONAL, InputMethod.OPTIONAL_POSITIONAL]

    @property
    def is_optional(self) -> bool:
        return self in [InputMethod.OPTIONAL_POSITIONAL, InputMethod.OPTION]


class RedirectedIO(StringIO):
    def __init__(self, pipe: Any) -> None:
        super().__init__()
        self.pipe = pipe

    def write(self, s: str) -> int:
        self.pipe.send(s)
        return len(s)


# --------------- String & Advanced Utility Functions ---------------


def camel_case_to_kebab_case(name: str) -> str:
    """Converts a camel case string to a kebab case string.

    Also converts underscores to hyphens (snake_case -> kebab-case).

    Args:
        name: The string to be converted.

    Returns:
        The converted kebab-case string.
    """
    result = ""
    for i, char in enumerate(name):
        if char == "_":
            result += "-"
        elif char.isupper() and i > 0:
            # Avoid double hyphens
            if not result or result[-1] != "-":
                result += "-"
            result += char.lower()
        else:
            result += char.lower()
    # Remove any leading/trailing hyphens
    return result.strip("-")


def split_unquoted(unsplit: str, delimeter: str, limit: Union[int, float] = math.inf) -> List[str]:
    """Splits text at a delimiter, as long as that delimiter is not quoted (either single ' or double quotes ").

    Args:
        unsplit: The text to be split.
        delimeter: The delimiter to split at.
        limit: The maximum number of splits to perform, default is math.inf.

    Returns:
        A list of strings.
    """
    if limit <= 0:
        return [unsplit]

    # Find all split positions (indices of unquoted delimiters)
    split_positions: List[int] = []
    in_single = False
    in_double = False
    for i, char in enumerate(unsplit):
        if char == "'" and not in_double:
            in_single = not in_single
        elif char == '"' and not in_single:
            in_double = not in_double
        elif char == delimeter and not in_single and not in_double:
            split_positions.append(i)

    if limit < float('inf'):
        split_positions = split_positions[:int(limit)]

    # Build result from split positions
    result: List[str] = []
    prev = 0
    for pos in split_positions:
        result.append(unsplit[prev:pos])
        prev = pos + 1
    result.append(unsplit[prev:])

    return result


def unwrap_quotes(qs: str) -> str:
    """Removes quotes wrapping a string - they must be matching, and also be the first and last character.

    Args:
        qs: The string to be unwrapped.

    Returns:
        The unwrapped string.
    """
    if len(qs) >= 2:
        if (qs[0] == "'" and qs[-1] == "'") or (qs[0] == '"' and qs[-1] == '"'):
            return qs[1:-1]
    return qs


def get_ancestors(command_name: str) -> List[str]:
    """List all ancestors for a given command. For example, `foo bar bat` yields a list with:
    * `__root__`
    * `__root__ foo`
    * `__root__ foo bar`

    Args:
        command_name: The name of the command to get the ancestors of.

    Returns:
        A list of strings.
    """
    parts = command_name.split()
    ancestors = ["__root__"]
    for i in range(len(parts)):
        ancestors.append(f"__root__ {' '.join(parts[:i + 1])}")
    return ancestors


def normalize_name(name: str, spaces: bool = True) -> str:
    """Normalize a name to be a valid Python identifier.

    Args:
        name: The name to be normalized.
        spaces: Whether to allow spaces in the name, default is True.

    Returns:
        The normalized string.
    """
    if spaces:
        name = name.replace(" ", "_")
    name = "".join(c if c.isalnum() or c == "_" else "_" for c in name)
    if name and name[0].isdigit():
        name = "_" + name
    return name


def normalize_action_input(values: Union[str, Sequence[Any], None]) -> List[str]:
    """Normalize `values` input to be a list.

    Args:
        values: The values to be normalized.

    Returns:
        A list of strings.
    """
    if values is None:
        return []
    if isinstance(values, str):
        return [values]
    return list(str(v) for v in values)


def get_parser_name(prog_name: str) -> str:
    """Get the name of the parser.

    Args:
        prog_name: The name of the program.

    Returns:
        The name of the parser.
    """
    return Path(prog_name).stem


def get_enum_member_docs(enum_class: Type[enum.Enum]) -> Dict[str, str]:
    """Get the documentation for each member of an enum.

    Args:
        enum_class: The enum class to get the documentation for.

    Returns:
        A dictionary of strings.
    """
    docs: Dict[str, str] = {}
    for member in enum_class:
        doc = ""
        if member.__doc__:
            doc = member.__doc__
        else:
            # Try to get from class __doc__
            class_doc = enum_class.__doc__
            if class_doc:
                try:
                    parsed = docstring_parser.parse(class_doc)
                    for param in parsed.params:
                        if param.arg_name == member.name:
                            doc = param.description or ""
                            break
                except Exception:
                    pass
        docs[member.name] = doc
    return docs


def info_for_flags(cli_arg_name: str, flag_class: Type[enum.Flag]) -> List[EnumFlagInfo]:
    """Get the information for a flag.

    Args:
        cli_arg_name: The name of the flag.
        flag_class: The flag class to get the information for.

    Returns:
        A list of `EnumFlagInfo`.
    """
    infos: List[EnumFlagInfo] = []
    for member in flag_class:
        option_names: List[str] = []
        if hasattr(member, "_names_"):
            for n in member._names_:
                option_names.append(f"--{n}")
        if not option_names:
            option_names = [f"--{member.name.lower()}"]

        cli_name = normalize_name(member.name, spaces=False)
        infos.append(EnumFlagInfo(
            option=tuple(option_names),
            cli_arg_name=cli_name,
            value=member,
            description=get_enum_member_docs(flag_class).get(member.name, "")
        ))
    return infos


def parse_short_and_long_name(
    long_name: Optional[str], arg_description: str, func_or_class: Callable
) -> Tuple[str, Optional[str], Optional[str]]:
    """Parse a short and long name into a tuple of strings.

    Args:
        long_name: The long name to be parsed.
        arg_description: The argument description to be parsed.
        func_or_class: The function or class to be parsed.

    Returns:
        A tuple of (long_name, short_name, metavar).
    """
    short_name: Optional[str] = None
    metavar: Optional[str] = None
    if long_name:
        if " " in long_name:
            parts = long_name.split(" ", 1)
            short_name = parts[0].rstrip(",")
            long_name = parts[1]
        if "," in long_name:
            parts = long_name.split(",", 1)
            long_name = parts[0]
            metavar = parts[1].strip()
    if not long_name and func_or_class:
        long_name = camel_case_to_kebab_case(
            func_or_class.__name__ if hasattr(func_or_class, "__name__") else str(func_or_class)
        )
    return (long_name, short_name, metavar)


def capture_stdout_stderr(
    stdout_writer: Any, stderr_writer: Any, target: Callable, args: Tuple[Any, ...]
) -> None:
    """Capture stdout and stderr from a function call.

    Args:
        stdout_writer: The stdout writer.
        stderr_writer: The stderr writer.
        target: The function to be called.
        args: The arguments to be passed to the function.

    Returns:
        None.
    """
    old_stdout = sys.stdout
    old_stderr = sys.stderr
    try:
        sys.stdout = stdout_writer
        sys.stderr = stderr_writer
        target(*args)
    finally:
        sys.stdout = old_stdout
        sys.stderr = old_stderr


def io_redirector(proc: multiprocessing.Process, pipe: Any, file: TextIO) -> None:
    """Redirect IO for a process.

    Args:
        proc: The process to be redirected.
        pipe: The pipe to be redirected.
        file: The file to be redirected.

    Returns:
        None.
    """
    try:
        while True:
            msg = pipe.recv()
            file.write(msg)
            file.flush()
    except EOFError:
        pass


def run_redirected_io(
    mp_ctx: multiprocessing.context.SpawnContext, target: Callable, args: Tuple[Any, ...]
) -> None:
    """Run a function with redirected IO.

    Args:
        mp_ctx: The multiprocessing context to be used.
        target: The function to be run.
        args: The arguments to be passed to the function.

    Returns:
        None.
    """
    stdout_pipe, stdout_conn = multiprocessing.Pipe()
    stderr_pipe, stderr_conn = multiprocessing.Pipe()

    p = mp_ctx.Process(target=capture_stdout_stderr, args=(
        RedirectedIO(stdout_conn),
        RedirectedIO(stderr_conn),
        target,
        args,
    ))
    p.start()

    stdout_proc = mp_ctx.Process(target=io_redirector, args=(p, stdout_pipe, sys.stdout))
    stderr_proc = mp_ctx.Process(target=io_redirector, args=(p, stderr_pipe, sys.stderr))
    stdout_proc.start()
    stderr_proc.start()

    p.join()
    stdout_conn.close()
    stderr_conn.close()
    stdout_proc.join()
    stderr_proc.join()


def get_callable_methods(cls: type) -> List[Callable]:
    """Get the callable methods from a class.

    Args:
        cls: The class to get the callable methods from.

    Returns:
        A list of callable methods.
    """
    methods: List[Callable] = []
    for name in dir(cls):
        attr = getattr(cls, name, None)
        if attr and callable(attr) and not name.startswith("_"):
            methods.append(attr)
    return methods


def log_args(logger_fn: Callable, msg: str, fn_name: str, *args: Any, **kwargs: Any) -> ArgSpec:
    """Log arguments.

    Args:
        logger_fn: The logger function to be used.
        msg: The message to be logged.
        fn_name: The name of the function to be logged.
        args: The arguments to be logged.
        kwargs: The keyword arguments to be logged.

    Returns:
        An `ArgSpec` object.
    """
    spec = ArgSpec(args=args, kwargs=kwargs)
    logger_fn(f"{msg} {fn_name}: args={args}, kwargs={kwargs}")
    return spec


def func_or_class_info(func_or_class: Callable) -> Optional[Tuple[str, int]]:
    """Get the information for a function or class.

    Args:
        func_or_class: The function or class to get the information for.

    Returns:
        A tuple of (info_string, id) or None.
    """
    if hasattr(func_or_class, "__name__"):
        name = func_or_class.__name__
    else:
        name = str(func_or_class)
    if hasattr(func_or_class, "__module__"):
        module = func_or_class.__module__
    else:
        module = None
    if module:
        return (f"{module}:{name}", id(func_or_class))
    return (name, id(func_or_class))


def is_async_callable(obj: Any) -> bool:
    """Checks if an object is an async callable - https://stackoverflow.com/a/72682939.

    Args:
        obj: The object to be checked.

    Returns:
        True if the object is an async callable, False otherwise.
    """
    if asyncio.iscoroutinefunction(obj):
        return True
    if callable(obj) and asyncio.iscoroutinefunction(getattr(obj, "__call__", None)):
        return True
    return False


def load_and_run_inner(file: Path, *args: str, debug: bool, no_warn: bool) -> LoadAndRunResult:
    """Load and run an inner function.

    Args:
        file: The file to be loaded and run.
        args: The arguments to be passed to the function.
        debug: Whether to enable debug mode.
        no_warn: Whether to enable no warning mode.

    Returns:
        A `LoadAndRunResult` object.
    """
    result = LoadAndRunResult()
    try:
        if not file.exists():
            result.error = f"File not found: {file}"
            return result

        import importlib.util
        spec = importlib.util.spec_from_file_location(file.stem, file)
        if spec is None or spec.loader is None:
            result.error = f"Could not load module from {file}"
            return result

        module = importlib.util.module_from_spec(spec)
        old_argv = sys.argv
        sys.argv = [str(file), *args]

        try:
            spec.loader.exec_module(module)
        finally:
            sys.argv = old_argv

        import arguably
        return result

    except Exception as e:
        result.error = str(e)
        result.exception = e
        return result


def load_and_run(results: multiprocessing.Queue, file: Path, argv: List[str], debug: bool, no_warn: bool) -> None:
    """Load and run a function.

    Args:
        results: The queue to store the results.
        file: The file to be loaded and run.
        argv: The arguments to be passed to the function.
        debug: Whether to enable debug mode.
        no_warn: Whether to enable no warning mode.

    Returns:
        None.
    """
    result = load_and_run_inner(file, *argv, debug=debug, no_warn=no_warn)
    results.put(result)


def append_argv(*args: str) -> Callable:
    """Prepend args to sys.argv as a decorator.

    Args:
        args: The arguments to prepend.

    Returns:
        A decorator function.
    """
    def decorator(func: Callable) -> Callable:
        def wrapper(*fargs, **fkwargs):
            old_argv = sys.argv.copy()
            sys.argv = sys.argv[:1] + list(args) + sys.argv[1:]
            try:
                return func(*fargs, **fkwargs)
            finally:
                sys.argv = old_argv
        return wrapper
    return decorator


def get_and_clear_io():
    """Get and clear captured IO.

    Returns:
        A tuple of (stdout StringIO, stderr StringIO).
    """
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    return stdout, stderr


def run_cli_and_manual(argv, target=None, *, manual_func=None):
    """Run CLI and manual generation.

    Args:
        argv: The command-line arguments.
        target: The target function to call.
        manual_func: An optional manual generation function.

    Returns:
        The result of the target function.
    """
    old_argv = sys.argv
    sys.argv = argv
    try:
        if target:
            return target()
        return None
    finally:
        sys.argv = old_argv


def run_cli_and_manual_main(argv, target=None, *, manual_func=None):
    """Main entry point for run_cli_and_manual.

    Args:
        argv: The command-line arguments.
        target: The target function to call.
        manual_func: An optional manual generation function.

    Returns:
        The result of the target function.
    """
    return run_cli_and_manual(argv, target=target, manual_func=manual_func)


def warn(message: str, func_or_class: Optional[Callable] = None) -> None:
    """Provide a warning. We avoid using logging, since we're just a library, so we issue through `warnings`.

    Args:
        message: The warning message to be displayed.
        func_or_class: The function or class that caused the warning, default is None.

    Returns:
        None.
    """
    if func_or_class is not None:
        func_info = func_or_class_info(func_or_class)
        if func_info:
            message = f"{func_info[0]}: {message}"
    warnings.warn(message, category=ArguablyWarning, stacklevel=2)
