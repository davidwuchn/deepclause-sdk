#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
autojump_argparse.py - Argument parsing utilities for Autojump.

Provides constants, helper functions, and full argparse-compatible classes
for building command-line interfaces within the Autojump project.
"""

import sys
import os
import copy
import textwrap


def _(s):
    """Simple translation helper (identity for now)."""
    return s


# ---------------------------------------------------------------------------
# Module-level constants
# ---------------------------------------------------------------------------

__version__ = str
__all__ = list

SUPPRESS = '==SUPPRESS=='
OPTIONAL = '?'
ZERO_OR_MORE = '*'
ONE_OR_MORE = '+'
PARSER = 'A...'
REMAINDER = '...'
_UNRECOGNIZED_ARGS_ATTR = '_unrecognized_args'


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

def _callable(obj):
    """Check if an object is callable."""
    return hasattr(obj, '__call__')


def _ensure_value(namespace, name, value):
    """Ensure a value exists on the namespace; use *value* if not already present.

    Returns the ensured value (getattr(namespace, name)).
    """
    if not hasattr(namespace, name):
        setattr(namespace, name, value)
    return getattr(namespace, name)


def _get_action_name(argument):
    """Get the name of an action (string representation for help/errors)."""
    if argument is None:
        return 'None'
    elif hasattr(argument, 'option_strings') and argument.option_strings:
        return str(argument.option_strings)
    elif hasattr(argument, 'dest'):
        return str(argument.dest)
    else:
        return str(argument)


# ---------------------------------------------------------------------------
# _AttributeHolder
# ---------------------------------------------------------------------------

class _AttributeHolder(object):
    """Base class providing __repr__ and introspection helpers."""

    def __init__(self, **kwargs):
        pass

    def _get_kwargs(self):
        """Return list of (key, value) tuples for relevant attributes."""
        return []

    def _get_args(self):
        """Return list of positional arguments."""
        return []

    def __repr__(self):
        args = self._get_args()
        kwargs = self._get_kwargs()
        arg_str = ', '.join(repr(a) for a in args) + \
                  ', '.join('%s=%r' % (k, v) for k, v in kwargs)
        if not args and not kwargs:
            return '%s()' % type(self).__name__
        return '%s(%s)' % (type(self).__name__, arg_str)


# ---------------------------------------------------------------------------
# Namespace
# ---------------------------------------------------------------------------

class Namespace(_AttributeHolder):
    """Simple object for storing attributes."""

    def __init__(self, **kwargs):
        for name, value in kwargs.items():
            setattr(self, name, value)

    def __eq__(self, other):
        if isinstance(other, Namespace):
            return self.__dict__ == other.__dict__
        return NotImplemented

    def __ne__(self, other):
        return not self.__eq__(other)

    def __contains__(self, key):
        return key in self.__dict__

    def _get_kwargs(self):
        return sorted(self.__dict__.items())

    def __repr__(self):
        args = self._get_args()
        kwargs = self._get_kwargs()
        return '%s(%s)' % (type(self).__name__,
                           ', '.join(repr(a) for a in args) +
                           ', '.join('%s=%r' % (k, v) for k, v in kwargs))


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------

class ArgumentError(Exception):
    """Exception raised for argument parsing errors."""

    def __init__(self, argument, message):
        self.argument = argument
        self.message = message
        super(ArgumentError, self).__init__(message)

    def __str__(self):
        return self.message


class ArgumentTypeError(Exception):
    """Exception raised for argument type conversion errors."""
    pass


# ---------------------------------------------------------------------------
# Action classes
# ---------------------------------------------------------------------------

class Action(_AttributeHolder):
    """Information about how to convert command line strings to Python objects."""

    def __init__(self, option_strings, dest, nargs=None, const=None,
                 default=None, type=None, choices=None, required=False,
                 help=None, metavar=None):
        self.option_strings = option_strings
        self.dest = dest
        self.nargs = nargs
        self.const = const
        self.default = default
        self.type = type
        self.choices = choices
        self.required = required
        self.help = help
        self.metavar = metavar

    def __call__(self, parser, namespace, values, option_string=None):
        raise NotImplementedError('Action is missing __call__ implementation')

    def _get_kwargs(self):
        return [
            ('option_strings', self.option_strings),
            ('dest', self.dest),
            ('nargs', self.nargs),
            ('const', self.const),
            ('default', self.default),
            ('type', self.type),
            ('choices', self.choices),
            ('required', self.required),
            ('help', self.help),
            ('metavar', self.metavar),
        ]


class _StoreAction(Action):
    """Action that stores the argument value."""

    def __init__(self, option_strings, dest, nargs=None, const=None,
                 default=None, type=None, choices=None, required=False,
                 help=None, metavar=None):
        if nargs == 0:
            raise ValueError('nargs for store actions must be > 0; got 0')
        if const is not None and nargs != OPTIONAL:
            raise ValueError('nargs must be %r to supply const' % OPTIONAL)
        super(_StoreAction, self).__init__(
            option_strings, dest, nargs=nargs, const=const,
            default=default, type=type, choices=choices,
            required=required, help=help, metavar=metavar)

    def __call__(self, parser, namespace, values, option_string=None):
        # Apply type conversion if specified
        if self.type is not None and values is not None:
            if isinstance(values, list):
                values = [self.type(v) for v in values]
            else:
                values = self.type(values)
        setattr(namespace, self.dest, values)


class _StoreConstAction(Action):
    """Action that stores a constant value."""

    def __init__(self, option_strings, dest, const, default=None,
                 required=False, help=None, metavar=None):
        super(_StoreConstAction, self).__init__(
            option_strings, dest, nargs=0, const=const,
            default=default, required=required, help=help)

    def __call__(self, parser, namespace, values, option_string=None):
        setattr(namespace, self.dest, self.const)


class _StoreTrueAction(_StoreConstAction):
    """Action that stores True."""

    def __init__(self, option_strings, dest, default=False,
                 required=False, help=None):
        super(_StoreTrueAction, self).__init__(
            option_strings, dest, const=True, default=default,
            required=required, help=help)


class _StoreFalseAction(_StoreConstAction):
    """Action that stores False."""

    def __init__(self, option_strings, dest, default=True,
                 required=False, help=None):
        super(_StoreFalseAction, self).__init__(
            option_strings, dest, const=False, default=default,
            required=required, help=help)


class _AppendAction(Action):
    """Action that appends the argument value to a list."""

    def __init__(self, option_strings, dest, nargs=None, const=None,
                 default=None, type=None, choices=None, required=False,
                 help=None, metavar=None):
        if nargs == 0:
            raise ValueError('nargs for append actions must be > 0; got 0')
        if const is not None and nargs != OPTIONAL:
            raise ValueError('nargs must be %r to supply const' % OPTIONAL)
        super(_AppendAction, self).__init__(
            option_strings, dest, nargs=nargs, const=const,
            default=default, type=type, choices=choices,
            required=required, help=help, metavar=metavar)

    def __call__(self, parser, namespace, values, option_string=None):
        if self.type is not None and values is not None:
            if isinstance(values, list):
                values = [self.type(v) for v in values]
            else:
                values = self.type(values)
        items = copy.copy(
            getattr(namespace, self.dest, None) or
            copy.copy(self.default) or [])
        items.append(values)
        setattr(namespace, self.dest, items)


class _AppendConstAction(Action):
    """Action that appends a constant value to a list."""

    def __init__(self, option_strings, dest, const, default=None,
                 required=False, help=None, metavar=None):
        super(_AppendConstAction, self).__init__(
            option_strings, dest, nargs=0, const=const,
            default=default, required=required, help=help)

    def __call__(self, parser, namespace, values, option_string=None):
        items = copy.copy(
            getattr(namespace, self.dest, None) or
            copy.copy(self.default) or [])
        items.append(self.const)
        setattr(namespace, self.dest, items)


class _CountAction(Action):
    """Action that counts the number of times an argument appears."""

    def __init__(self, option_strings, dest, default=None,
                 required=False, help=None):
        super(_CountAction, self).__init__(
            option_strings, dest, nargs=0, default=default,
            required=required, help=help)

    def __call__(self, parser, namespace, values, option_string=None):
        current = getattr(namespace, self.dest, None)
        if current is None:
            current = 0
        setattr(namespace, self.dest, current + 1)


class _HelpAction(Action):
    """Action that displays help information."""

    def __init__(self, option_strings, dest=SUPPRESS, default=SUPPRESS,
                 help=None, **kwargs):
        # required and other kwargs are ignored for help action
        super(_HelpAction, self).__init__(
            option_strings, dest, nargs=0, default=default, help=help)

    def __call__(self, parser, namespace, values, option_string=None):
        parser.print_help()
        parser.exit(0)


class _VersionAction(Action):
    """Action that displays version information."""

    def __init__(self, option_strings, version=None, dest=SUPPRESS,
                 default=SUPPRESS, help=_("show program's version number and exit")):
        super(_VersionAction, self).__init__(
            option_strings, dest, nargs=0, default=default,
            help=help)
        self.version = version

    def __call__(self, parser, namespace, values, option_string=None):
        fmt = parser._get_formatter()
        version = self.version
        if version is None:
            version = parser.version
        if version:
            parser.exit(0, str(version) + "\n")
        else:
            parser.exit(0)


class _SubParsersAction(Action):
    """Action that handles subparsers."""

    class _ChoicesPseudoAction(Action):
        def __init__(self, choice, container):
            self._container = container
            self._choice = choice
            super(_SubParsersAction._ChoicesPseudoAction, self).__init__(
                option_strings=[], dest=choice)

    def __init__(self, *args, **kwargs):
        super(_SubParsersAction, self).__init__(*args, **kwargs)
        self._name_parser_map = {}
        self._parser_class = None
        self._choices_actions = []

    def add_parser(self, name, **kwargs):
        if self._parser_class is None:
            raise ValueError('No parser class set')
        parser = self._parser_class(**kwargs)
        self._name_parser_map[name] = parser
        choice_action = self._ChoicesPseudoAction(name, self)
        self._choices_actions.append(choice_action)
        return parser


# ---------------------------------------------------------------------------
# FileType
# ---------------------------------------------------------------------------

class FileType(object):
    """Class for handling file type arguments."""

    def __init__(self, mode='r', bufsize=-1, encoding=None, errors=None):
        self.mode = mode
        self.bufsize = bufsize
        self.encoding = encoding
        self.errors = errors

    def __call__(self, string):
        try:
            return open(string, self.mode, self.bufsize,
                        self.encoding, self.errors)
        except IOError as e:
            raise ArgumentTypeError(
                _('%s: %r: %s') % (self.__class__.__name__, string, e))

    def __repr__(self):
        args = []
        for name in 'mode', 'bufsize', 'encoding', 'errors':
            value = getattr(self, name)
            default = {'mode': 'r', 'bufsize': -1, 'encoding': None,
                       'errors': None}[name]
            if value != default:
                args.append('%s=%r' % (name, value))
        return '%s(%s)' % (type(self).__name__, ', '.join(args))


# ---------------------------------------------------------------------------
# HelpFormatter
# ---------------------------------------------------------------------------

class HelpFormatter(object):
    """Base class for formatting help text."""

    def __init__(self, prog, indent_increment=2, max_help_position=24,
                 width=None):
        self.prog = prog
        self._indent_increment = indent_increment
        self._max_help_position = max_help_position
        if width is None:
            cols = os.environ.get('COLUMNS', 80)
            try:
                width = int(cols) - 2
            except ValueError:
                width = 80
        self._width = max(width, 40)
        self._current_indent = 0
        self._action_max_length = self._max_help_position
        self._root_section = {"indent": 0, "indent_text": "", "heading": None, "items": []}
        self._sections = []
        self._current_section = None
        self._whitespace = ' ' * self._indent_increment

    def _indent(self):
        """Increase indentation level."""
        self._current_indent += self._indent_increment

    def _dedent(self):
        """Decrease indentation level."""
        self._current_indent = max(0, self._current_indent - self._indent_increment)

    def start_section(self, heading):
        """Start a new help section with given heading."""
        self._indent()
        section = {'indent': self._current_indent,
                   'indent_text': ' ' * self._current_indent,
                   'heading': heading,
                   'items': []}
        if self._sections:
            self._sections[-1]['items'].append(section)
        else:
            self._root_section['items'].append(section)
        self._sections.append(section)
        self._current_section = section

    def end_section(self):
        """End the current help section."""
        self._sections.pop()
        self._current_section = self._sections[-1] if self._sections else None
        self._dedent()

    def add_text(self, text):
        """Add text to the current section."""
        if text:
            if self._current_section is not None:
                self._current_section['items'].append(text)
            else:
                self._root_section['items'].append(text)

    def add_usage(self, usage, actions, groups, prefix=None):
        """Add usage information to the help."""
        if prefix is None:
            prefix = _('usage: ')
        if usage is not None and usage:
            usage_text = usage
        else:
            usage_text = self.prog + ' '
            for action in actions:
                if action.option_strings:
                    usage_text += '[%s] ' % action.option_strings[0]
            usage_text = usage_text.strip()
        self._root_section['items'].insert(0,
                                           prefix + usage_text)

    def add_argument(self, action):
        """Add argument help for a single action."""
        self._add_argument(action)

    def add_arguments(self, actions):
        """Add argument help for multiple actions."""
        for action in actions:
            self._add_argument(action)

    def _add_argument(self, action):
        """Internal: format and add a single argument."""
        if action.help and action.help != SUPPRESS:
            help_text = self._expand_help(action)
            invocation = self._format_action_invocation(action)
            actual_width = self._width - self._current_indent
            help_avail = actual_width - self._action_max_length
            if help_avail < 19:
                help_avail = actual_width
            first_line = '%*s%s' % (self._action_max_length,
                                    self._current_indent + len(invocation) + 1,
                                    invocation)
            # Pad invocation column
            pad = max(0, self._action_max_length - self._current_indent -
                      len(invocation))
            first_line = ' ' * self._current_indent + invocation + ' ' * (pad + 1)
            if help_text:
                help_width = self._width - self._current_indent - pad - 1
                lines = self._split_lines(help_text, help_width)
                first_line += lines[0] if lines else ''
                wrapped = [first_line]
                for line in lines[1:]:
                    wrapped.append(' ' * self._action_max_length + line)
                self._current_section['items'].append('\n'.join(wrapped))
            else:
                self._current_section['items'].append(first_line)

    def format_help(self):
        """Format and return the help text."""
        root = self._root_section
        items = root.get('items', [])
        parts = []
        for item in items:
            if isinstance(item, dict):
                # Nested section
                section_text = self._format_section(item)
                if section_text:
                    parts.append(section_text)
            elif isinstance(item, str) and item.strip():
                parts.append(self._dedent_text(item))
        return '\n'.join(parts) + '\n'

    def _format_section(self, section):
        """Format a section with heading and items."""
        heading = section.get('heading', '')
        indent_text = section.get('indent_text', '')
        items = section.get('items', [])
        parts = []
        if heading:
            parts.append(indent_text + heading)
        for item in items:
            if isinstance(item, dict):
                parts.append(self._format_section(item))
            elif isinstance(item, str):
                if item.strip():
                    parts.append(item)
        return '\n'.join(p for p in parts if p)

    def _join_parts(self, part_strings):
        """Join help text parts."""
        return '\n'.join(p for p in part_strings if p)

    def _format_usage(self, usage, actions, groups, prefix):
        """Format usage information."""
        if prefix is None:
            prefix = _('usage: ')
        return prefix + usage

    def _format_action(self, action):
        """Format a single action's help."""
        return action.option_strings[0] if action.option_strings else ''

    def _format_action_invocation(self, action):
        """Format action invocation string."""
        if not action.option_strings:
            metavar = self._get_metavar(action)
            nargs = action.nargs
            if isinstance(nargs, int):
                count = max(1, nargs)
            else:
                count = 1
            parts = [metavar] * count
            return ' '.join(parts)
        else:
            if len(action.option_strings) == 1:
                option_string = action.option_strings[0]
            else:
                # Use shortest
                option_string = min(action.option_strings, key=len)
            metavar = self._get_metavar(action)
            if action.nargs == 0:
                return option_string
            else:
                return '%s %s' % (option_string, metavar)

    def _format_text(self, text):
        """Format text with proper wrapping."""
        text_width = max(self._width - self._current_indent, 20)
        indent = ' ' * self._current_indent
        return self._fill_text(text, text_width, indent)

    def _format_args(self, action, default_metavar):
        """Format argument strings."""
        return default_metavar

    def _expand_help(self, action):
        """Expand help text for an action."""
        params = dict(prog=self.prog)
        if hasattr(action, 'default'):
            if action.default is not SUPPRESS and action.default is not None:
                params['default'] = action.default
            else:
                params['default'] = ''
        if hasattr(action, 'choices'):
            if action.choices:
                params['choices'] = ', '.join(str(c) for c in action.choices)
            else:
                params['choices'] = ''
        return action.help % params if action.help else ''

    def _iter_indented_subactions(self, action):
        """Iterate over indented subactions."""
        return iter([])

    def _split_lines(self, text, width):
        """Split text into lines of specified width."""
        return textwrap.wrap(text, width)

    def _fill_text(self, text, width, indent):
        """Fill text to specified width with indentation."""
        wrapped = []
        for paragraph in text.split('\n\n'):
            lines = paragraph.split('\n')
            joined = ' '.join(lines)
            if joined.strip():
                textwrap_width = max(width, 10)
                textwrap_indent = indent
                if len(indent) > width - 1:
                    textwrap_indent = ''
                filled = textwrap.fill(joined, width=textwrap_width,
                                       initial_indent=textwrap_indent,
                                       subsequent_indent=textwrap_indent)
                wrapped.append(filled)
        return '\n\n'.join(wrapped)

    def _get_help_string(self, action):
        """Get help string for an action."""
        return action.help if action.help and action.help != SUPPRESS else ''

    def _dedent_text(self, text):
        """Dedent text."""
        return textwrap.dedent(text)

    def _get_metavar(self, action):
        """Get metavar for an action."""
        if action.metavar:
            return str(action.metavar)
        return (action.dest or '').upper()


# ---------------------------------------------------------------------------
# RawDescriptionHelpFormatter
# ---------------------------------------------------------------------------

class RawDescriptionHelpFormatter(HelpFormatter):
    """Help message formatter which retains any formatting in descriptions."""

    def _fill_text(self, text, width, indent):
        """Fill text with proper indentation, preserving line breaks."""
        paragraphs = text.split('\n\n')
        wrapped = []
        for paragraph in paragraphs:
            lines = paragraph.split('\n')
            joined_lines = []
            for line in lines:
                stripped = line.rstrip()
                if stripped:
                    joined_lines.append(indent + stripped)
                else:
                    joined_lines.append('')
            wrapped.append('\n'.join(joined_lines))
        return '\n\n'.join(wrapped)


# ---------------------------------------------------------------------------
# RawTextHelpFormatter
# ---------------------------------------------------------------------------

class RawTextHelpFormatter(RawDescriptionHelpFormatter):
    """Help message formatter which retains formatting of all help text."""

    def _split_lines(self, text, width):
        """Split text into lines, preserving original line breaks."""
        return text.splitlines()


# ---------------------------------------------------------------------------
# ArgumentDefaultsHelpFormatter
# ---------------------------------------------------------------------------

class ArgumentDefaultsHelpFormatter(HelpFormatter):
    """Help message formatter which adds default values to argument help."""

    def _get_help_string(self, action):
        """Get help string with default values added."""
        help_string = action.help if action.help and action.help != SUPPRESS else ''
        if not help_string:
            return ''
        if '%(default)' not in help_string:
            if hasattr(action, 'default') and action.default is not None \
                    and action.default is not SUPPRESS:
                help_string += ' (default: %(default)s)'
        return help_string


# ---------------------------------------------------------------------------
# _ActionsContainer
# ---------------------------------------------------------------------------

class _ActionsContainer(object):
    """Container for managing and organizing command-line argument actions."""

    def __init__(self, description, prefix_chars, argument_default,
                 conflict_handler):
        self.description = description or ''
        self.prefix_chars = prefix_chars
        self.argument_default = argument_default
        self.conflict_handler = conflict_handler
        self._actions = []
        self._option_string_actions = {}
        self._registries = {}
        self._defaults = {}
        self._has_positional = False
        self.argument_groups = []
        self._mutually_exclusive_groups = []

        # Register default action types
        self.register('action', 'store', _StoreAction)
        self.register('action', 'store_const', _StoreConstAction)
        self.register('action', 'store_true', _StoreTrueAction)
        self.register('action', 'store_false', _StoreFalseAction)
        self.register('action', 'append', _AppendAction)
        self.register('action', 'append_const', _AppendConstAction)
        self.register('action', 'count', _CountAction)
        self.register('action', 'help', _HelpAction)
        self.register('action', 'version', _VersionAction)

    def register(self, registry_name, value, object_):
        """Register an object in the specified registry."""
        registry = self._registries.setdefault(registry_name, {})
        registry[value] = object_

    def _registry_get(self, registry_name, value, default=None):
        """Retrieve an object from a specified registry."""
        return self._registries.get(registry_name, {}).get(value, default)

    def set_defaults(self, **kwargs):
        """Set default values for the namespace."""
        for name, value in kwargs.items():
            self._defaults[name] = value

    def get_default(self, dest):
        """Get the default value for an argument destination."""
        for action in self._actions:
            if action.dest == dest:
                return action.default
        return self._defaults.get(dest)

    def add_argument(self, *args, **kwargs):
        """Add a new command-line argument to the container."""
        if args:
            first = args[0]
            prefix_chars_set = set(self.prefix_chars)
            is_optional = (isinstance(first, str) and
                           first and first[0] in prefix_chars_set)
        else:
            is_optional = False

        if is_optional:
            kwargs = self._get_optional_kwargs(*args, **kwargs)
        else:
            kwargs = self._get_positional_kwargs(*args, **kwargs)

        action_class = self._pop_action_class(kwargs)
        if action_class is None:
            action_class = _StoreAction

        action = action_class(**kwargs)
        self._add_action(action)
        return action

    def add_argument_group(self, *args, **kwargs):
        """Create and return a new argument group."""
        group = _ArgumentGroup(self, *args, **kwargs)
        self.argument_groups.append(group)
        return group

    def add_mutually_exclusive_group(self, **kwargs):
        """Create and return a new mutually exclusive group."""
        group = _MutuallyExclusiveGroup(self, **kwargs)
        self._mutually_exclusive_groups.append(group)
        return group

    def _add_action(self, action):
        """Internal: add an Action object to the container."""
        self._check_conflict(action)
        self._actions.append(action)
        for option_string in action.option_strings:
            self._option_string_actions[option_string] = action
        return action

    def _remove_action(self, action):
        """Remove a specified Action object from the container."""
        self._actions.remove(action)
        for option_string in action.option_strings:
            if self._option_string_actions.get(option_string) is action:
                del self._option_string_actions[option_string]

    def _add_container_actions(self, container):
        """Add all actions from another container."""
        for action in container._actions:
            self._add_action(copy.copy(action))
        for group in container.argument_groups:
            self.argument_groups.append(copy.copy(group))
        for group in container._mutually_exclusive_groups:
            self._mutually_exclusive_groups.append(copy.copy(group))

    def _get_positional_kwargs(self, dest, **kwargs):
        """Generate keyword arguments for a positional argument."""
        kwargs['dest'] = dest
        kwargs.setdefault('option_strings', [])
        if kwargs.get('nargs') is None:
            kwargs['nargs'] = '?'
        if 'help' not in kwargs:
            kwargs['help'] = None
        return kwargs

    def _get_optional_kwargs(self, *args, **kwargs):
        """Generate keyword arguments for an optional argument."""
        kwargs['option_strings'] = list(args)
        dest = kwargs.get('dest')
        if dest is None:
            # Pick the longest option string (e.g., --flag over -f)
            best = None
            for opt in args:
                opt_clean = opt.lstrip('-')
                if '=' in opt_clean:
                    opt_clean = opt_clean.split('=')[0]
                if best is None or len(opt_clean) > len(best):
                    best = opt_clean
            if best:
                dest = best.replace('-', '_')
            else:
                dest = 'dest'
        kwargs['dest'] = dest
        kwargs.setdefault('option_strings', [])
        if 'help' not in kwargs:
            kwargs['help'] = None
        if 'required' not in kwargs:
            kwargs['required'] = False
        return kwargs

    def _pop_action_class(self, kwargs, default=None):
        """Pop the action class from kwargs and return it."""
        action = kwargs.pop('action', default)
        if isinstance(action, str):
            action = self._registry_get('action', action, default)
        return action

    def _get_handler(self):
        """Get the conflict handling method."""
        if self.conflict_handler == 'resolve':
            return self._handle_conflict_resolve
        return self._handle_conflict_error

    def _check_conflict(self, action):
        """Check if a new action conflicts with existing ones."""
        handler = self._get_handler()
        conflicting = []
        for option_string in action.option_strings:
            if option_string in self._option_string_actions:
                existing = self._option_string_actions[option_string]
                if existing is not action:
                    conflicting.append((option_string, existing))
        if conflicting:
            handler(action, conflicting)

    def _handle_conflict_error(self, action, conflicting_actions):
        """Raise an ArgumentError when conflicts are detected."""
        conflicts = [
            (string, act) for string, act in conflicting_actions
        ]
        raise ArgumentError(action,
                            _('conflicting option string: %s') %
                            ', '.join(s for s, _ in conflicts))

    def _handle_conflict_resolve(self, action, conflicting_actions):
        """Resolve conflicts by removing old options."""
        for option_string, existing in conflicting_actions:
            if option_string in self._option_string_actions:
                del self._option_string_actions[option_string]


# ---------------------------------------------------------------------------
# _ArgumentGroup
# ---------------------------------------------------------------------------

class _ArgumentGroup(_ActionsContainer):
    """Group for organizing arguments in help messages."""

    def __init__(self, container, title=None, description=None, **kwargs):
        self._container = container
        self.title = title
        self.description = description or ''
        super(_ArgumentGroup, self).__init__(
            description=description or '',
            prefix_chars=container.prefix_chars,
            argument_default=container.argument_default,
            conflict_handler=container.conflict_handler)

    def _add_action(self, action):
        """Add an action to this group."""
        return self._container._add_action(action)

    def _remove_action(self, action):
        """Remove an action from this group."""
        self._container._remove_action(action)
        if action in self._actions:
            self._actions.remove(action)


# ---------------------------------------------------------------------------
# _MutuallyExclusiveGroup
# ---------------------------------------------------------------------------

class _MutuallyExclusiveGroup(_ArgumentGroup):
    """Group of mutually exclusive arguments."""

    def __init__(self, container, required=False):
        super(_MutuallyExclusiveGroup, self).__init__(container)
        self.required = required

    def _add_action(self, action):
        """Add an action to this mutually exclusive group."""
        if action.required:
            raise ValueError('mutually exclusive arguments must be optional')
        return super(_MutuallyExclusiveGroup, self)._add_action(action)

    def _remove_action(self, action):
        """Remove an action from this group."""
        super(_MutuallyExclusiveGroup, self)._remove_action(action)


# ---------------------------------------------------------------------------
# ArgumentParser
# ---------------------------------------------------------------------------

class ArgumentParser(_AttributeHolder, _ActionsContainer):
    """Object for parsing command line strings into Python objects."""

    def __init__(self, prog=None, usage=None, description=None, epilog=None,
                 version=None, parents=[],
                 formatter_class=HelpFormatter,
                 prefix_chars='-', fromfile_prefix_chars=None,
                 argument_default=None, conflict_handler='error',
                 add_help=True):
        if prog is None:
            prog = os.path.basename(sys.argv[0]) if sys.argv else 'program'

        self.prog = prog
        self.usage = usage
        self.epilog = epilog
        self.version = version
        self.formatter_class = formatter_class
        self.fromfile_prefix_chars = fromfile_prefix_chars

        _ActionsContainer.__init__(
            self,
            description=description or '',
            prefix_chars=prefix_chars,
            argument_default=argument_default if argument_default is not None else None,
            conflict_handler=conflict_handler)

        if add_help:
            self.add_argument('-h', '--help', action='help',
                              help=_('show this help message and exit'))

        for parent in parents:
            self._add_container_actions(parent)

    # ---- delegation methods ----

    def add_argument(self, *args, **kwargs):
        return super(ArgumentParser, self).add_argument(*args, **kwargs)

    def add_argument_group(self, *args, **kwargs):
        return super(ArgumentParser, self).add_argument_group(*args, **kwargs)

    def add_mutually_exclusive_group(self, **kwargs):
        return super(ArgumentParser, self).add_mutually_exclusive_group(**kwargs)

    def add_subparsers(self, **kwargs):
        kwargs.setdefault('dest', None)
        kwargs.setdefault('help', '')
        kwargs.setdefault('choices', {})
        subparsers_action = _SubParsersAction(
            option_strings=[], dest=kwargs.get('dest'))
        subparsers_action._parser_class = ArgumentParser
        self._add_action(subparsers_action)
        return subparsers_action

    # ---- parsing entry points ----

    def parse_args(self, args=None, namespace=None):
        args, _ = self.parse_known_args(args, namespace)
        return args

    def parse_known_args(self, args=None, namespace=None):
        if namespace is None:
            namespace = Namespace()
        if args is None:
            args = sys.argv[1:]

        # Apply container defaults
        for key, value in self._defaults.items():
            _ensure_value(namespace, key, value)

        # Apply action defaults
        for action in self._actions:
            if hasattr(action, 'default') and action.default is not None \
                    and action.default is not SUPPRESS:
                _ensure_value(namespace, action.dest, action.default)

        positional_actions = [a for a in self._actions if not a.option_strings]
        optional_actions = [a for a in self._actions if a.option_strings]

        # Build fast lookup map option_string -> action
        opt_map = {}
        for action in optional_actions:
            for os_ in action.option_strings:
                opt_map[os_] = action

        # Build map of single-char short options (only for nargs==0)
        short0 = {}
        for opt, act in opt_map.items():
            if opt.startswith('-') and not opt.startswith('--') and \
               len(opt) == 2 and act.nargs == 0:
                short0[opt[1]] = act

        arg_strings_iter = iter(args)
        positional_values = []

        for arg_string in arg_strings_iter:
            prefix_set = set(self.prefix_chars)
            is_optional = (arg_string and len(arg_string) > 1 and
                           arg_string[0] in prefix_set)

            if is_optional:
                matched = False

                # Handle --key=value
                if not matched and '=' in arg_string and arg_string.startswith('--'):
                    key_part, value_part = arg_string.split('=', 1)
                    if key_part in opt_map:
                        act = opt_map[key_part]
                        if act.nargs == 0:
                            act(self, namespace, None, arg_string)
                        else:
                            act(self, namespace, value_part, arg_string)
                        matched = True

                # Handle repeated short options: -vvv => -v -v -v
                if not matched and len(arg_string) > 2 and \
                   arg_string[0] == '-' and arg_string[1] in short0:
                    act = short0[arg_string[1]]
                    for ch in arg_string[1:]:
                        if ch in short0:
                            short0[ch](self, namespace, None, '-' + ch)
                        else:
                            break
                    matched = True

                # Normal optional lookup
                if not matched:
                    for action in optional_actions:
                        if arg_string in action.option_strings:
                            if action.nargs == 0:
                                action(self, namespace, None, arg_string)
                            else:
                                nargs = action.nargs
                                if nargs == '?' or nargs is None:
                                    try:
                                        nxt = next(arg_strings_iter)
                                        action(self, namespace, nxt, arg_string)
                                    except StopIteration:
                                        action(self, namespace, None, arg_string)
                                elif nargs == '*':
                                    vals = list(arg_strings_iter)
                                    action(self, namespace, vals, arg_string)
                                elif nargs == '+':
                                    vals = list(arg_strings_iter)
                                    action(self, namespace, vals, arg_string)
                                else:
                                    try:
                                        nxt = next(arg_strings_iter)
                                        action(self, namespace, nxt, arg_string)
                                    except StopIteration:
                                        pass
                            matched = True
                            break

                if not matched:
                    positional_values.append(arg_string)
            else:
                positional_values.append(arg_string)

        # Assign positional values (use setattr to override any defaults)
        idx = 0
        for pa in positional_actions:
            nargs = pa.nargs
            if nargs == '*':
                # consume all remaining
                vals = positional_values[idx:]
                setattr(namespace, pa.dest, vals)
                idx = len(positional_values)
            elif nargs == '+':
                vals = positional_values[idx:idx + len(positional_values)]
                setattr(namespace, pa.dest, vals)
                idx += len(vals)
            elif nargs == '?' or nargs is None:
                if idx < len(positional_values):
                    setattr(namespace, pa.dest, positional_values[idx])
                    idx += 1
            elif isinstance(nargs, int) and nargs > 0:
                vals = positional_values[idx:idx + nargs]
                setattr(namespace, pa.dest, vals)
                idx += nargs

        return namespace, []

    # ---- formatting methods ----

    def format_usage(self):
        formatter = self._get_formatter()
        formatter.add_usage(self.usage, self._actions, self.argument_groups)
        return formatter.format_help()

    def format_help(self):
        formatter = self._get_formatter()

        if self.description:
            formatter.add_text(self._format_description(self.description))

        formatter.add_usage(self.usage, self._actions, self.argument_groups)

        pos_actions = [a for a in self._actions if not a.option_strings]
        if pos_actions:
            formatter.start_section('positional arguments')
            formatter.add_arguments(pos_actions)
            formatter.end_section()

        opt_actions = [a for a in self._actions if a.option_strings]
        if opt_actions:
            formatter.start_section('optional arguments')
            formatter.add_arguments(opt_actions)
            formatter.end_section()

        for group in self.argument_groups:
            group_actions = [a for a in group._actions]
            if group_actions:
                title = group.title or ''
                formatter.start_section(title)
                if group.description:
                    formatter.add_text(self._format_description(group.description))
                formatter.add_arguments(group_actions)
                formatter.end_section()

        if self.epilog:
            formatter.add_text(self._format_description(self.epilog))

        return formatter.format_help()

    def _format_description(self, text):
        formatter = self._get_formatter()
        return formatter._format_text(text)

    def format_version(self):
        if self.version:
            return self.version
        return ''

    def print_usage(self, file=None):
        if file is None:
            file = sys.stdout
        file.write(self.format_usage())

    def print_help(self, file=None):
        if file is None:
            file = sys.stdout
        file.write(self.format_help())

    def print_version(self, file=None):
        if file is None:
            file = sys.stdout
        file.write(self.format_version() + '\n')

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write(_('error: %s\n') % message)
        self.exit(2)

    def exit(self, status=0, message=None):
        if message:
            sys.stderr.write(message + '\n')
        sys.exit(status)

    # ---- delegation (delegate to _ActionsContainer) ----

    def set_defaults(self, **kwargs):
        super(ArgumentParser, self).set_defaults(**kwargs)

    def get_default(self, dest):
        return super(ArgumentParser, self).get_default(dest)

    def _add_action(self, action):
        return super(ArgumentParser, self)._add_action(action)

    def _remove_action(self, action):
        super(ArgumentParser, self)._remove_action(action)

    # ---- internal helpers ----

    def _get_positional_actions(self):
        return [a for a in self._actions if not a.option_strings]

    def _get_optional_actions(self):
        return [a for a in self._actions if a.option_strings]

    def _parse_known_args(self, arg_strings, namespace):
        return self.parse_known_args(arg_strings, namespace)

    def _parse_optional(self, arg_string):
        """Return the Action for an optional string, or None."""
        return self._option_string_actions.get(arg_string)

    def _get_values(self, action, arg_strings):
        return arg_strings

    def _get_value(self, action, arg_string):
        return arg_string

    def _check_value(self, action, value):
        if action.choices is not None and value not in action.choices:
            raise ArgumentTypeError(
                _('"{}" is not a valid choice. '
                  'Choose from: {}')
                .format(value, ', '.join(str(c) for c in action.choices)))

    def _get_formatter(self):
        return self.formatter_class(prog=self.prog)


# ---------------------------------------------------------------------------
# End of autojump_argparse.py
# ---------------------------------------------------------------------------
