"""Modifier classes for customizing command-line argument behavior in Arguably.

This module provides modifier classes that can be used with `Annotated[]` type hints
to customize how arguments are parsed and validated. Each modifier implements
`check_valid` and `modify_arg_dict` methods to validate parameters and configure
the argparse parser respectively.
"""

import argparse
import enum
import inspect
from dataclasses import dataclass, field
from typing import (
    Any,
    Callable,
    Dict,
    List,
    Optional,
    Sequence,
    Tuple,
    Union,
)

from arguably._commands import Command, CommandArg, CommandArgModifier
from arguably._util import (
    ArguablyException,
    InputMethod,
    normalize_action_input,
)


@dataclass(frozen=True)
class CountedModifier(CommandArgModifier):
    """Counts the number of times a flag is provided.

    For example, `-vvvv` would yield `4`. Used with `@Annotated[int, arguably.arg.count()]`.
    """

    def check_valid(
        self, value_type: type, param: inspect.Parameter, function_name: str
    ) -> None:
        """Validates that the counted modifier is used with an integer type.

        Args:
            value_type: The type of the value.
            param: The parameter to check.
            function_name: The name of the function.

        Raises:
            ArguablyException: If the type is not int or the parameter kind is invalid.
        """
        if not issubclass(value_type, int):
            raise ArguablyException(
                f"Counted modifier on `{param.name}` in `{function_name}` requires type `int`, "
                f"got `{value_type.__name__}`"
            )

    def modify_arg_dict(
        self,
        command: Command,
        arg_: CommandArg,
        kwargs_dict: Dict[str, Any],
    ) -> None:
        """Configures the argparse argument to use 'count' action.

        Args:
            command: The command to modify the kwargs for.
            arg_: The argument to modify the kwargs for.
            kwargs_dict: The kwargs dictionary to modify.
        """
        kwargs_dict.update(action="count", default=0)


@dataclass(frozen=True)
class RequiredModifier(CommandArgModifier):
    """Marks an input as required. In the case of a variadic positional arg,
    uses the '+' symbol to represent this."""

    def check_valid(
        self, value_type: type, param: inspect.Parameter, function_name: str
    ) -> None:
        """Validates that the required modifier is not used with a bool type.

        Args:
            value_type: The type of the value.
            param: The parameter to check.
            function_name: The name of the function.

        Raises:
            ArguablyException: If the type is bool.
        """
        if issubclass(value_type, bool):
            raise ArguablyException("Cannot mark a bool as required.")

    def modify_arg_dict(
        self,
        command: Command,
        arg_: CommandArg,
        kwargs_dict: Dict[str, Any],
    ) -> None:
        """Configures the argparse argument to be required.

        For optional positional args, changes nargs from '?' to '+' to indicate
        one or more values required.

        Args:
            command: The command to modify the kwargs for.
            arg_: The argument to modify the kwargs for.
            kwargs_dict: The kwargs dictionary to modify.
        """
        if arg_.input_method == InputMethod.OPTIONAL_POSITIONAL:
            kwargs_dict.update(nargs="+")
        elif arg_.input_method == InputMethod.OPTION:
            kwargs_dict.update(required=True)


@dataclass(frozen=True)
class BuilderModifier(CommandArgModifier):
    """Sets up arguably builder. Treats the input as instructions on how to build a class."""

    def modify_arg_dict(
        self,
        command: Command,
        arg_: CommandArg,
        kwargs_dict: Dict[str, Any],
    ) -> None:
        """Configures the argparse argument to use ListTupleBuilderAction.

        Args:
            command: The command to modify the kwargs for.
            arg_: The argument to modify the kwargs for.
            kwargs_dict: The kwargs dictionary to modify.
        """
        from arguably._argparse_extensions import ListTupleBuilderAction

        kwargs_dict.update(action=ListTupleBuilderAction, command_arg=arg_)


@dataclass(frozen=True)
class HandlerModifier(CommandArgModifier):
    """Allows full user control over how an input is handled. A function should be
    passed in to parse the string from the command line.

    Skips all the argument processing arguably does and just calls func.
    """

    handler: Callable[[str], Any]

    def check_valid(
        self, value_type: type, param: inspect.Parameter, function_name: str
    ) -> None:
        """Validates that the handler is callable.

        Args:
            value_type: The type of the value.
            param: The parameter to check.
            function_name: The name of the function.

        Raises:
            ArguablyException: If the handler is not callable.
        """
        if not callable(self.handler):
            raise ArguablyException(
                f"Handler modifier on `{param.name}` in `{function_name}` requires a callable, "
                f"got `{type(self.handler).__name__}`"
            )

    def modify_arg_dict(
        self,
        command: Command,
        arg_: CommandArg,
        kwargs_dict: Dict[str, Any],
    ) -> None:
        """Configures the argparse argument to use the custom handler as its type converter.

        Args:
            command: The command to modify the kwargs for.
            arg_: The argument to modify the kwargs for.
            kwargs_dict: The kwargs dictionary to modify.
        """
        kwargs_dict.update(type=self.handler)


@dataclass(frozen=True)
class ChoicesModifier(CommandArgModifier):
    """Restricts inputs to one of a given set of choices.

    Specifies a fixed set of values that a parameter is allowed to be.
    """

    choices: Tuple[Union[str, enum.Enum], ...]

    def check_valid(
        self, value_type: type, param: inspect.Parameter, function_name: str
    ) -> None:
        """Validates that the choices modifier has at least one choice.

        Args:
            value_type: The type of the value.
            param: The parameter to check.
            function_name: The name of the function.

        Raises:
            ArguablyException: If no choices are provided.
        """
        if len(self.choices) == 0:
            raise ArguablyException(
                f"Choices modifier on `{param.name}` in `{function_name}` requires at least one choice."
            )

    def modify_arg_dict(
        self,
        command: Command,
        arg_: CommandArg,
        kwargs_dict: Dict[str, Any],
    ) -> None:
        """Configures the argparse argument with the restricted set of choices.

        Args:
            command: The command to modify the kwargs for.
            arg_: The argument to modify the kwargs for.
            kwargs_dict: The kwargs dictionary to modify.
        """
        kwargs_dict.update(choices=self.choices)


@dataclass(frozen=True)
class MissingArgDefaultModifier(CommandArgModifier):
    """Allows an option to be a flag, passing a default value instead of a value
    provided via the command line.

    Allows the value to be omitted: just `--option` will use the given `omit_value`.
    """

    missing_value: Any

    def modify_arg_dict(
        self,
        command: Command,
        arg_: CommandArg,
        kwargs_dict: Dict[str, Any],
    ) -> None:
        """Configures the argparse argument to accept optional values with a default.

        Uses nargs='?' and const=missing_value so that `--option` alone uses the
        missing_value, while `--option VALUE` uses the provided value.

        Args:
            command: The command to modify the kwargs for.
            arg_: The argument to modify the kwargs for.
            kwargs_dict: The kwargs dictionary to modify.
        """
        kwargs_dict.update(nargs="?", const=self.missing_value)


@dataclass(frozen=True)
class ListModifier(CommandArgModifier):
    """Sets up arguably list handling. Sensitive to the `_RequiredModifier`."""

    def modify_arg_dict(
        self,
        command: Command,
        arg_: CommandArg,
        kwargs_dict: Dict[str, Any],
    ) -> None:
        """Configures the argparse argument for list-style (nargs='*') collection.

        If a RequiredModifier is also present, uses nargs='+' (one or more) instead
        of nargs='*' (zero or more).

        Args:
            command: The command to modify the kwargs for.
            arg_: The argument to modify the kwargs for.
            kwargs_dict: The kwargs dictionary to modify.
        """
        # Check if RequiredModifier is also present
        has_required = any(
            isinstance(m, RequiredModifier) for m in arg_.modifiers
        )
        if has_required:
            kwargs_dict.update(nargs="+")
        else:
            kwargs_dict.update(nargs="*", default=[])


@dataclass(frozen=True)
class TupleModifier(CommandArgModifier):
    """Sets up arguably tuple handling."""

    tuple_arg: List[type]

    def modify_arg_dict(
        self,
        command: Command,
        arg_: CommandArg,
        kwargs_dict: Dict[str, Any],
    ) -> None:
        """Configures the argparse argument for tuple-style collection with type converters.

        Args:
            command: The command to modify the kwargs for.
            arg_: The argument to modify the kwargs for.
            kwargs_dict: The kwargs dictionary to modify.
        """
        from arguably._argparse_extensions import ListTupleBuilderAction

        if arg_.metavars is None:
            kwargs_dict.update(
                metavar=",".join([arg_.cli_arg_name] * len(self.tuple_arg))
            )
        kwargs_dict.update(
            action=ListTupleBuilderAction,
            command_arg=arg_,
            type=self.tuple_arg,
        )


# ---- Factory functions for creating modifiers ----


def count() -> CountedModifier:
    """Counts the number of times a flag is given. For example, `-vvvv` would yield `4`.

    Returns:
        A CountedModifier for use with `Annotated[]`.
    """
    return CountedModifier()


def required() -> RequiredModifier:
    """Marks a field as required. For `*args` or a `list[]`, requires at least one item.

    Returns:
        A RequiredModifier for use with `Annotated[]`.
    """
    return RequiredModifier()


def choices(*choices: Union[str, enum.Enum]) -> ChoicesModifier:
    """Specifies a fixed set of values that a parameter is allowed to be.

    Args:
        *choices: The allowed choices for the parameter.

    Returns:
        A ChoicesModifier for use with `Annotated[]`.
    """
    return ChoicesModifier(choices=choices)


def missing(omit_value: Any) -> MissingArgDefaultModifier:
    """Allows the value to be omitted: just `--option` will use the given `omit_value`.

    Args:
        omit_value: The value to use when the option is provided without a value.

    Returns:
        A MissingArgDefaultModifier for use with `Annotated[]`.
    """
    return MissingArgDefaultModifier(missing_value=omit_value)


def handler(func: Callable[[str], Any]) -> HandlerModifier:
    """Skips all the argument processing arguably does and just calls `func`.

    Args:
        func: The handler function to call with the string argument.

    Returns:
        A HandlerModifier for use with `Annotated[]`.
    """
    return HandlerModifier(handler=func)


def builder() -> BuilderModifier:
    """Treats the input as instructions on how to build a class.

    Returns:
        A BuilderModifier for use with `Annotated[]`.
    """
    return BuilderModifier()
