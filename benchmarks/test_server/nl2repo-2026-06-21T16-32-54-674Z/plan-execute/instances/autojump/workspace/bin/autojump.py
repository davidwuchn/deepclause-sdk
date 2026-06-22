#!/usr/bin/env python
"""
Autojump - a smart file system navigation tool.

This module provides the core autojump command-line interface,
including argument parsing, path matching, database operations,
and the main entry point.
"""

import sys
import os
import math
import itertools

# Core constants
VERSION = '22.5.3'
FUZZY_MATCH_THRESHOLD = 0.6
TAB_ENTRIES_COUNT = 9
TAB_SEPARATOR = '__'

# Local imports
from bin.autojump_argparse import ArgumentParser, SUPPRESS
from bin.autojump_data import Entry, load, save, BACKUP_THRESHOLD
from bin.autojump_match import match_anywhere, match_consecutive, match_fuzzy
from bin.autojump_utils import (
    get_pwd,
    unico,
    print_local,
    surround_quotes,
    has_uppercase,
    encode_local,
    is_python2,
)

# Determine data file location based on platform
def _get_data_path():
    """Return the platform-specific autojump data file path."""
    try:
        if 'XDG_DATA_HOME' in os.environ:
            data_home = os.environ['XDG_DATA_HOME']
        else:
            home = os.path.expanduser('~')
            if sys.platform == 'darwin':
                data_home = os.path.join(home, 'Library', 'autojump')
            elif sys.platform == 'win32':
                appdata = os.environ.get('APPDATA', os.path.join(home, 'AppData', 'Roaming'))
                data_home = os.path.join(appdata, 'autojump')
            else:
                data_home = os.path.join(home, '.local', 'share', 'autojump')
        return os.path.join(data_home, 'autojump.txt')
    except Exception:
        return os.path.join(os.path.expanduser('~'), '.autojump.txt')


def _get_config():
    """Return a configuration dictionary for autojump data operations."""
    data_path = _get_data_path()
    backup_path = data_path + '.bak'
    return {
        'data_path': data_path,
        'backup_path': backup_path,
        'fuzzy_threshold': FUZZY_MATCH_THRESHOLD,
        'max_results': None,
        'tab_entries_count': TAB_ENTRIES_COUNT,
    }


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

def set_defaults(parser):
    """Set default values on an ArgumentParser for autojump operations.

    Args:
        parser: An ArgumentParser instance.
    """
    parser.set_defaults(
        directory=[],
        add=None,
        increase=10,
        decrease=15,
        complete=False,
        purge=False,
        stat=False,
    )


def parse_arguments(args=None):
    """Parse command line arguments for autojump.

    Args:
        args: Optional list of argument strings (defaults to sys.argv[1:]).

    Returns:
        Namespace object with attributes: directory, add, increase,
        decrease, complete, purge, stat.
    """
    parser = ArgumentParser(
        prog='autojump',
        description='Autojump is a quick directory navigation tool.',
    )
    set_defaults(parser)

    parser.add_argument(
        'directory',
        nargs='*',
        help='Directory paths to jump to (search terms).',
    )
    parser.add_argument(
        '-a', '--add',
        metavar='PATH',
        default=SUPPRESS,
        help='Add a directory path to the database.',
    )
    parser.add_argument(
        '-i', '--increase',
        type=int,
        metavar='WEIGHT',
        default=SUPPRESS,
        help='Weight to increase when visiting a directory (default: 10).',
    )
    parser.add_argument(
        '-d', '--decrease',
        type=int,
        metavar='WEIGHT',
        default=SUPPRESS,
        help='Weight to decrease for a directory (default: 15).',
    )
    parser.add_argument(
        '--complete',
        action='store_true',
        default=SUPPRESS,
        help='Enable tab completion mode.',
    )
    parser.add_argument(
        '--purge',
        action='store_true',
        default=SUPPRESS,
        help='Remove non-existent paths from the database.',
    )
    parser.add_argument(
        '-s', '--stat',
        action='store_true',
        default=SUPPRESS,
        help='Show database statistics.',
    )

    return parser.parse_args(args)


# ---------------------------------------------------------------------------
# Weight / path operations
# ---------------------------------------------------------------------------

def add_path(data, path, weight=15):
    """Add *weight* to an existing path or insert a new entry.

    Weight formula:  new_weight = sqrt(old_weight^2 + weight^2)

    Args:
        data: dict mapping path -> Entry (or path -> float).
        path: directory path to add/increase.
        weight: amount to add (default 15).

    Returns:
        (data, entry) tuple with the updated dictionary and the Entry.
    """
    path = os.path.abspath(path)
    if path in data:
        old_weight = data[path].weight if isinstance(data[path], Entry) else data[path]
        new_weight = math.sqrt(old_weight ** 2 + weight ** 2)
    else:
        new_weight = weight
    entry = Entry(path=path, weight=new_weight)
    data[path] = entry
    return data, entry


def decrease_path(data, path, weight=15):
    """Decrease the weight of *path* by *weight*.

    If the resulting weight is <= 0, remove the entry entirely.

    Args:
        data: dict mapping path -> Entry.
        path: directory path to decrease.
        weight: amount to subtract (default 15).

    Returns:
        (data, entry) or (data, None) if removed.
    """
    if path not in data:
        return data, None
    old_weight = data[path].weight if isinstance(data[path], Entry) else data[path]
    new_weight = old_weight - weight
    if new_weight <= 0:
        del data[path]
        return data, None
    entry = Entry(path=path, weight=new_weight)
    data[path] = entry
    return data, entry


# ---------------------------------------------------------------------------
# Matching helpers
# ---------------------------------------------------------------------------

def detect_smartcase(needles):
    """Return ``True`` if any needle contains an uppercase letter.

    When True, matching should be case-sensitive.
    """
    return any(has_uppercase(n) for n in needles)


def find_matches(config, needles, children=False):
    """Find matching directory entries for *needles*.

    Args:
        config: configuration dictionary (must contain ``data_path``).
        needles: list of search terms (strings).
        children: if True, prefer subdirectories of the current directory.

    Returns:
        Sorted list of Entry objects (highest weight first).
    """
    database = load(config)
    haystack = list(database.values())

    if not needles:
        return []

    ignore_case = not detect_smartcase(needles)

    matches = []
    if children:
        # Prefer subdirectories: match consecutive in order
        matches = list(match_consecutive(needles, haystack, ignore_case=ignore_case))
        # Fallback to anywhere
        if not matches:
            matches = list(match_anywhere(needles, haystack, ignore_case=ignore_case))
        # Fallback to fuzzy
        if not matches:
            matches = list(match_fuzzy(needles, haystack, ignore_case=ignore_case,
                                       threshold=config.get('fuzzy_threshold', FUZZY_MATCH_THRESHOLD)))
    else:
        # Standard: anywhere first, then consecutive, then fuzzy
        matches = list(match_anywhere(needles, haystack, ignore_case=ignore_case))
        if not matches:
            matches = list(match_consecutive(needles, haystack, ignore_case=ignore_case))
        if not matches:
            matches = list(match_fuzzy(needles, haystack, ignore_case=ignore_case,
                                       threshold=config.get('fuzzy_threshold', FUZZY_MATCH_THRESHOLD)))

    # Sort by weight descending
    matches.sort(key=lambda e: e.weight, reverse=True)
    return matches


# ---------------------------------------------------------------------------
# Tab completion
# ---------------------------------------------------------------------------

def handle_tab_completion(config, needle, tab_entries, tab_separator=TAB_SEPARATOR):
    """Handle tab-completion mode.

    If ``needle`` has multiple tab-completion entries separated by
    *tab_separator*, resolve to the final path and cd there.
    Otherwise, print the tab menu.

    Args:
        config: configuration dictionary.
        needle: the (possibly compound) search string.
        tab_entries: list of tab entry strings.
        tab_separator: separator used between entries.

    Returns:
        0 on success, 1 on failure.
    """
    from bin.autojump_utils import get_tab_entry_info, print_tab_menu

    if tab_entries:
        entry_str = tab_entries[0]
        needle, index, path = get_tab_entry_info(entry_str, tab_separator)
        if index is not None:
            try:
                if is_python2():
                    os.chdir(path.encode('utf-8', 'replace'))
                else:
                    os.chdir(path)
                print_local(path)
                return 0
            except OSError:
                return 1
    else:
        print_tab_menu(needle, tab_entries, tab_separator)
        return 0
    return 0


# ---------------------------------------------------------------------------
# Purge / Stats
# ---------------------------------------------------------------------------

def purge_missing_paths(config):
    """Remove entries whose paths no longer exist on disk.

    Args:
        config: configuration dictionary.

    Returns:
        Number of removed entries.
    """
    database = load(config)
    removed = 0
    for path in list(database):
        if not os.path.isdir(path):
            del database[path]
            removed += 1
    if removed > 0:
        save(config, database)
    return removed


def print_stats(config):
    """Print a summary of the directory database.

    Args:
        config: configuration dictionary.

    Returns:
        0 on success.
    """
    database = load(config)
    if not database:
        print_local("No data.")
        return 0

    total = len(database)
    sorted_entries = sorted(database.values(), key=lambda e: e.weight, reverse=True)

    # Print top 10
    top_n = min(10, total)
    print_local("Top {} of {} entries:".format(top_n, total))
    for entry in sorted_entries[:top_n]:
        print_local("  {0:8.2f}  {1}".format(entry.weight, entry.path))
    return 0


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def main(argv=None):
    """Main entry point for the autojump CLI.

    Args:
        argv: Optional list of arguments (defaults to sys.argv[1:]).

    Returns:
        Exit code (0 = success, non-zero = error).
    """
    config = _get_config()

    try:
        args = parse_arguments(argv)
    except SystemExit as exc:
        return exc.code if exc.code is not None else 0

    # Purge mode
    if args.purge:
        removed = purge_missing_paths(config)
        print_local("Removed {} entries.".format(removed))
        return 0

    # Stats mode
    if args.stat:
        return print_stats(config)

    # Add mode
    if args.add is not None:
        database = load(config)
        database, _ = add_path(database, args.add)
        save(config, database)
        return 0

    # Jump mode – find matches for the directory arguments
    if args.directory:
        needles = args.directory
        matches = find_matches(config, needles)

        if not matches:
            print_local("No matches for: {}".format(' '.join(needles)))
            return 1

        best = matches[0]
        target = best.path

        # Change directory (inform parent shell via command substitution)
        print_local(target)
        return 0

    # No arguments at all – print usage via exit
    return 0


if __name__ == '__main__':
    sys.exit(main())
