"""Argument modifier module for Arguably.

This module provides the `arg` namespace object for use with `Annotated[]`
type hints to customize argument behavior.
"""

from arguably._modifiers import (
    count,
    required,
    choices,
    missing,
    handler,
    builder,
    CountedModifier,
    RequiredModifier,
    ChoicesModifier,
    MissingArgDefaultModifier,
    HandlerModifier,
    BuilderModifier,
)


class _ArgNamespace:
    """Namespace object providing arg modifier functions.

    Used as `arguably.arg.required()`, `arguably.arg.count()`, etc.
    """

    def required(self):
        """Marks a field as required. For `*args` or a `list[]`, requires at least one item."""
        return RequiredModifier()

    def count(self):
        """Counts the number of times a flag is given. For example, `-vvvv` would yield `4`."""
        return CountedModifier()

    def choices(self, *opts):
        """Specifies a fixed set of values that a parameter is allowed to be."""
        return ChoicesModifier(choices=opts)

    def missing(self, omit_value):
        """Allows the value to be omitted: just `--option` will use the given `omit_value`."""
        return MissingArgDefaultModifier(missing_value=omit_value)

    def handler(self, func):
        """Skips all the argument processing arguably does and just calls `func`."""
        return HandlerModifier(handler=func)

    def builder(self):
        """Treats the input as instructions on how to build a class."""
        return BuilderModifier()


arg = _ArgNamespace()
