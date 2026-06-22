"""Custom argparse actions and extensions for the Arguably library."""

import argparse
import enum
import inspect
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple, Union, cast

from arguably._util import EnumFlagInfo, normalize_action_input


class FlagAction(argparse.Action):
    """Special action for arguably - handles `enum.Flag`. Clears default value and ORs together flag values."""

    def __init__(self, option_strings, dest, **kwargs):
        # Keep const in kwargs so argparse.Action stores it as self.const
        super().__init__(option_strings, dest, **kwargs)

    def __call__(
        self,
        parser: argparse.ArgumentParser,
        namespace: argparse.Namespace,
        values: Union[str, Sequence[Any], None],
        option_string: Optional[str] = None,
    ) -> None:
        from arguably._context import context

        flag_info = cast(EnumFlagInfo, self.const)
        value = flag_info.value

        if context.check_and_set_enum_flag_default_status(parser, flag_info.cli_arg_name):
            value |= getattr(namespace, flag_info.cli_arg_name)
        setattr(namespace, flag_info.cli_arg_name, value)


class ListTupleBuilderAction(argparse.Action):
    """Custom argparse action for building lists and tuples from repeated/commma-separated arguments."""

    def __init__(self, option_strings, dest, **kwargs):
        # Pop custom keys before passing to super().__init__
        self.command_arg = kwargs.pop('command_arg', None)
        self._type_converter = kwargs.pop('_arguably_tuple_types', kwargs.pop('type', None))
        super().__init__(option_strings, dest, **kwargs)
        # DO NOT set self.type to _type_converter - argparse validates self.type is callable

    def __call__(
        self,
        parser: argparse.ArgumentParser,
        namespace: argparse.Namespace,
        values: Union[str, Sequence[Any], None],
        option_string: Optional[str] = None,
    ) -> None:
        # Normalize input to a list
        current: list = getattr(namespace, self.dest, None)
        if current is None:
            current = []

        # Get the type converter, if any
        type_converter = self._type_converter  # our custom type converter

        # Convert new values
        if isinstance(values, str):
            # Single string value - might be comma-separated for tuples
            if isinstance(type_converter, (list, tuple)) and len(type_converter) > 0:
                # Tuple: parse comma-separated values
                parts = values.split(",")
                if len(parts) == len(type_converter):
                    try:
                        converted = tuple(
                            type_converter[i](p.strip()) for i, p in enumerate(parts)
                        )
                        current.append(converted)
                    except (ValueError, TypeError):
                        pass
                else:
                    # Treat as single-item list
                    current.append(values)
            else:
                current.append(values)
        elif values is not None:
            for v in values:
                current.append(v)
        else:
            current.append(None)

        setattr(namespace, self.dest, current)


class ListTupleBuilderModifier(argparse.Action):
    """Custom action used internally for list/tuple argument processing with modifiers."""

    def __init__(self, option_strings, dest, **kwargs):
        self.type = kwargs.pop('type', None)
        self.command_arg = kwargs.pop('command_arg', None)
        super().__init__(option_strings, dest, **kwargs)

    def __call__(
        self,
        parser: argparse.ArgumentParser,
        namespace: argparse.Namespace,
        values: Union[str, Sequence[Any], None],
        option_string: Optional[str] = None,
    ) -> None:
        current: list = getattr(namespace, self.dest, None)
        if current is None:
            current = []
            setattr(namespace, self.dest, current)
        if isinstance(values, str):
            current.append(values)
        elif values is not None:
            if isinstance(values, str):
                current.append(values)
            else:
                current.extend(values)
        setattr(namespace, self.dest, current)
