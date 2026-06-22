"""
Arguably - A modern and user-friendly Python command-line argument parsing library.
"""

from arguably._context import context
from arguably._commands import (
    Command,
    CommandArg,
    CommandDecoratorInfo,
    SubtypeDecoratorInfo,
    InputMethod,
    NoDefault,
)
from arguably._util import (
    ArguablyException,
    ArguablyWarning,
    get_and_clear_io,
    run_cli_and_manual,
    run_cli_and_manual_main,
    append_argv,
    Permissions,
    PermissionsAlt,
    HiBye,
    MANUALLY_MANAGED,
    MANUAL,
)

from arguably._argparse_extensions import (
    FlagAction,
    ListTupleBuilderAction,
)

from arguably._modifiers import (
    required,
    count,
    choices,
    missing,
    handler,
    builder,
)

from arguably.arg import arg

__version__ = "0.1.0"

version = __version__

__all__ = [
    "command",
    "run",
    "error",
    "is_target",
    "subtype",
    "arg",
    "ArguablyException",
    "ArguablyWarning",
    "Permissions",
    "PermissionsAlt",
    "HiBye",
    "MANUAL",
    "get_and_clear_io",
    "run_cli_and_manual",
    "run_cli_and_manual_main",
    "append_argv",
    "required",
    "count",
    "choices",
    "missing",
    "handler",
    "builder",
]


def command(
    func=None,
    /,
    *,
    alias=None,
    help=True,
):
    """
    Mark a function as a command that should appear on the CLI.
    """
    def wrap(func_):
        context.add_command(function=func_, alias=alias, help=help)
        return func_

    return wrap if func is None else wrap(func)


def run(
    name=None,
    always_subcommand=False,
    version_flag=False,
    strict=True,
    show_defaults=True,
    show_types=True,
    max_description_offset=60,
    max_width=120,
    command_metavar="command",
    output=None,
):
    """
    Set up the argument parser, parse argv, and run the appropriate command(s).
    """
    return context.run(
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


def error(message: str) -> None:
    """
    Prints an error message and exits.
    """
    context.error(message)


def is_target() -> bool:
    """
    Returns True if the targeted command is being executed.
    """
    return context.is_target()


def subtype(
    cls=None,
    /,
    *,
    alias: str,
    factory=None,
):
    """
    Define configurable subtypes for complex parameter processing.
    """
    def wrap(cls_):
        context.add_subtype(type_=cls_, alias=alias, factory=factory)
        return cls_

    return wrap if cls is None else wrap(cls)
