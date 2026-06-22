"""
autojump_ipython.py - IPython integration for Autojump.

Provides the ``j`` magic command for IPython/Jupyter environments,
enabling smart directory jumping directly from notebooks or IPython
interactive sessions.

Usage::

    # In IPython or Jupyter notebook:
    In [1]: j projects

    # Or with multiple search terms:
    In [2]: j my project

    # To see top directories:
    In [3]: j --stat
"""

import os
import sys

# Make sure the parent directory is importable
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_PARENT_DIR = os.path.dirname(_SCRIPT_DIR)
if _PARENT_DIR not in sys.path:
    sys.path.insert(0, _PARENT_DIR)

from bin.autojump_data import load, Entry
from bin.autojump_match import match_anywhere, match_consecutive, match_fuzzy
from bin.autojump_utils import get_pwd, unico, print_local, surround_quotes, has_uppercase


# ---------------------------------------------------------------------------
# IPython magic: j
# ---------------------------------------------------------------------------

def _get_config():
    """Return a configuration dictionary for autojump data operations."""
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
        data_path = os.path.join(data_home, 'autojump.txt')
    except Exception:
        data_path = os.path.join(os.path.expanduser('~'), '.autojump.txt')
    return {
        'data_path': data_path,
        'backup_path': data_path + '.bak',
        'fuzzy_threshold': 0.6,
        'max_results': None,
        'tab_entries_count': 9,
    }


def _detect_smartcase(needles):
    """Return True if any needle contains uppercase letters."""
    return any(has_uppercase(n) for n in needles)


def _find_matches(config, needles, children=False):
    """Find matching directory entries for the given search needles.

    Args:
        config: configuration dictionary.
        needles: list of search term strings.
        children: if True, prefer child directories.

    Returns:
        Sorted list of Entry objects (highest weight first).
    """
    database = load(config)
    haystack = list(database.values())

    if not needles:
        return []

    ignore_case = not _detect_smartcase(needles)

    matches = []
    if children:
        matches = list(match_consecutive(needles, haystack, ignore_case=ignore_case))
        if not matches:
            matches = list(match_anywhere(needles, haystack, ignore_case=ignore_case))
        if not matches:
            matches = list(match_fuzzy(
                needles, haystack, ignore_case=ignore_case,
                threshold=config.get('fuzzy_threshold', 0.6),
            ))
    else:
        matches = list(match_anywhere(needles, haystack, ignore_case=ignore_case))
        if not matches:
            matches = list(match_consecutive(needles, haystack, ignore_case=ignore_case))
        if not matches:
            matches = list(match_fuzzy(
                needles, haystack, ignore_case=ignore_case,
                threshold=config.get('fuzzy_threshold', 0.6),
            ))

    matches.sort(key=lambda e: e.weight, reverse=True)
    return matches


def j(path, shell=None):
    """IPython magic function to jump to a directory using autojump.

    Searches the autojump database for directories matching *path*
    and changes the current working directory to the best match.

    Args:
        path (str): Path argument or search terms to look for.
                    Multiple space-separated words are supported.
        shell: IPython InteractiveShell instance (used when registered
               as a magic command). If not provided, falls back to
               os.chdir directly.

    Returns:
        None

    Examples::

        In [1]: j projects
        /home/user/projects

        In [2]: j my project
        /home/user/my_projects/src
    """
    # Strip leading 'j ' if called via magic line
    if path.startswith('j '):
        path = path[2:]
    # Strip leading 'j ' if called as %j magic
    path = path.strip()

    if not path:
        print("Usage: j <search_term>")
        return

    # Handle --stat special case
    if path == '--stat' or path == '-s':
        _print_stats()
        return

    needles = path.split()
    config = _get_config()

    matches = _find_matches(config, needles)

    if not matches:
        print("No matches found for '{}'".format(path))
        return

    best_match = matches[0]
    target = best_match.path

    # Update weight for the matched path
    _add_path(config, target)

    if shell is not None and hasattr(shell, 'os'):
        # IPython integration: change directory in the IPython shell
        shell.os.chdir(target)
    else:
        # Fallback: change directory in the current process
        os.chdir(target)

    print_local(target)


def _add_path(config, path):
    """Increment the weight of *path* in the autojump database.

    Args:
        config: configuration dictionary.
        path: directory path to increment.
    """
    database = load(config)
    weight = 15  # default increment
    old_weight = 0
    if path in database:
        entry = database[path]
        old_weight = entry.weight if isinstance(entry, Entry) else entry
    new_weight = (old_weight ** 2 + weight ** 2) ** 0.5
    database[path] = Entry(path=path, weight=new_weight)
    try:
        from bin.autojump_data import save
        save(config, database)
    except Exception:
        pass


def _print_stats():
    """Print the top entries from the autojump database."""
    config = _get_config()
    database = load(config)
    if not database:
        print("Database is empty.")
        return
    entries = sorted(database.values(), key=lambda e: e.weight, reverse=True)[:10]
    print("{:>10}  {}".format("weight", "path"))
    print("-" * 50)
    for entry in entries:
        w = entry.weight if isinstance(entry, Entry) else entry
        p = entry.path if isinstance(entry, Entry) else entry
        print("{:>10.1f}  {}".format(w, p))


# ---------------------------------------------------------------------------
# IPython magic registration (lazy, only if IPython is available)
# ---------------------------------------------------------------------------

def _register_ipython_magic():
    """Register the ``j`` line magic with the active IPython shell."""
    try:
        from IPython import get_ipython
        ip = get_ipython()
        if ip is not None:
            # Register as a line magic: %j or %%j
            ip.register_magic_function(j, 'line', 'j')
    except ImportError:
        # IPython not installed — nothing to register
        pass


# Auto-register when this module is imported inside IPython
_register_ipython_magic()
