"""
autojump_utils.py - Utility functions for the Autojump project.

Provides cross-platform utilities for directory creation, encoding,
platform detection, tab completion, path handling, and more.
"""

import os
import sys
import platform
import errno

# ---------------------------------------------------------------------------
# Helpers for Python 2 / 3 compatibility
# ---------------------------------------------------------------------------

def is_python2():
    """Check if running in Python 2 environment."""
    return sys.version_info[0] == 2


def is_python3():
    """Check if running in Python 3 environment."""
    return sys.version_info[0] == 3


def is_linux():
    """Check if running on Linux."""
    return platform.system() == 'Linux'


def is_osx():
    """Check if running on macOS."""
    return platform.system() == 'Darwin'


def is_windows():
    """Check if running on Windows."""
    return platform.system() == 'Windows'


# ---------------------------------------------------------------------------
# Encoding helpers
# ---------------------------------------------------------------------------

def unico(string):
    """Handle Unicode string processing for cross-platform compatibility.

    Args:
        string: String to process.

    Returns:
        Processed Unicode string.
    """
    if is_python3():
        return str(string)
    else:
        # Python 2: convert bytes to unicode
        if isinstance(string, bytes):
            return string.decode('utf-8', errors='replace')
        return unicode(string)


def encode_local(string):
    """Converts string into user's preferred encoding.

    Args:
        string: String to encode.

    Returns:
        Encoded string or bytes.
    """
    if is_python3():
        # In Python 3, strings are already unicode; encode to the preferred locale encoding
        try:
            return string.encode(sys.stdout.encoding or 'utf-8')
        except (UnicodeEncodeError, UnicodeDecodeError):
            return string.encode('utf-8')
    else:
        if isinstance(string, unicode):
            try:
                return string.encode(sys.stdout.encoding or 'utf-8')
            except (UnicodeEncodeError, UnicodeDecodeError):
                return string.encode('utf-8')
        return string


def print_local(string):
    """Print localized text with proper encoding.

    Args:
        string: Text to print.
    """
    try:
        encoded = encode_local(unico(string))
        if is_python2():
            sys.stdout.write(encoded)
            sys.stdout.write('\n')
        else:
            sys.stdout.write(string + '\n')
        sys.stdout.flush()
    except Exception:
        if is_python2():
            sys.stdout.write(str(string))
            sys.stdout.write('\n')
        else:
            print(string)


# ---------------------------------------------------------------------------
# String helpers
# ---------------------------------------------------------------------------

def has_uppercase(string):
    """Check if string contains uppercase letters.

    Args:
        string: String to check.

    Returns:
        Boolean indicating if string has uppercase letters.
    """
    return any(c.isupper() for c in string)


def surround_quotes(string):
    """Add quotes around a string if it contains spaces.

    Args:
        string: String to potentially quote.

    Returns:
        String with quotes if needed.
    """
    if ' ' in string or '\t' in string or '\n' in string:
        return "'" + string + "'"
    return string


# ---------------------------------------------------------------------------
# Iterator helpers
# ---------------------------------------------------------------------------

def first(xs):
    """Get the first element of an iterable.

    Args:
        xs: Iterable object.

    Returns:
        First element or None if not available.
    """
    try:
        return next(iter(xs))
    except StopIteration:
        return None


def second(xs):
    """Get the second element of an iterable.

    Args:
        xs: Iterable object.

    Returns:
        Second element or None if not available.
    """
    try:
        it = iter(xs)
        next(it)
        return next(it)
    except (StopIteration, TypeError):
        return None


def last(xs):
    """Get the last element of an iterable.

    Args:
        xs: Iterable object.

    Returns:
        Last element or None if not available.
    """
    try:
        lst = list(xs)
        return lst[-1]
    except (IndexError, TypeError):
        return None


def take(n, xs):
    """Take the first n elements from an iterable.

    Args:
        n: Number of elements to take.
        xs: Iterable object.

    Returns:
        List of first n elements.
    """
    try:
        lst = list(xs)
    except TypeError:
        lst = []
    return lst[:n]


# ---------------------------------------------------------------------------
# Directory / file helpers
# ---------------------------------------------------------------------------

def create_dir(path):
    """Creates a directory atomically.

    Args:
        path: Directory path to create.

    Raises:
        OSError: If directory cannot be created.
    """
    try:
        os.makedirs(path)
    except OSError as e:
        if e.errno != errno.EEXIST:
            raise


def get_pwd():
    """Get the current working directory.

    Returns:
        String representing the current working directory.
    """
    try:
        return os.getcwd()
    except OSError:
        return os.environ.get('PWD', '/')


def sanitize(string):
    """Sanitize a string for safe use in file paths or shell commands.

    Args:
        string: String to sanitize.

    Returns:
        Sanitized string.
    """
    if is_python3():
        # Remove null bytes and normalize
        cleaned = string.replace('\x00', '').strip()
        return cleaned
    else:
        cleaned = string.replace('\x00', '').strip()
        return cleaned


def print_entry(path, weight):
    """Print a directory entry in the standard autojump format.

    Args:
        path: Directory path.
        weight: Weight value.
    """
    print_local("{path}{sep}{weight}".format(
        path=path,
        sep=os.pathsep,
        weight=str(weight)
    ))


def move_file(src, dst):
    """Move file from source to destination.

    Args:
        src: Source file path.
        dst: Destination file path.

    Raises:
        Exception: If the file cannot be moved.
    """
    import shutil
    shutil.move(src, dst)


# ---------------------------------------------------------------------------
# Shell detection helpers
# ---------------------------------------------------------------------------

def in_bash():
    """Check if the program is running in a bash environment.

    Returns:
        Boolean indicating if running in bash.
    """
    shell = os.environ.get('SHELL', '')
    try:
        shell_path = os.environ.get('BASH_EXECUTION_STRING', '')
    except Exception:
        shell_path = ''
    if 'bash' in shell:
        return True
    # Also check if BASH environment variables are present
    if 'BASH_VERSION' in os.environ:
        return True
    return False


def is_autojump_sourced():
    """Check if autojump is already loaded in the current shell.

    Returns:
        Boolean indicating if autojump is loaded.
    """
    # Check for the _j function or AUTOJUMP variable
    if 'AUTOJUMP' in os.environ:
        return True
    if 'AUTOJUMP_HOME' in os.environ:
        return True
    # Check if _j is available as a command
    try:
        import subprocess
        result = subprocess.call(
            ['sh', '-c', 'type _j >/dev/null 2>&1'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        return result == 0
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Tab completion helpers
# ---------------------------------------------------------------------------

def get_tab_entry_info(entry, separator):
    """Given a tab entry, return needle, index, and path information.

    Args:
        entry: Tab entry string.
        separator: Separator character.

    Returns:
        Tuple containing needle, index, and path.
    """
    parts = entry.split(separator)
    if len(parts) >= 3:
        needle = separator.join(parts[1:-1])
        index = parts[0]
        path = parts[-1]
        return (needle, index, path)
    elif len(parts) == 2:
        needle = parts[0]
        index = parts[1]
        path = ''
        return (needle, index, path)
    else:
        needle = entry
        index = '0'
        path = ''
        return (needle, index, path)


def print_tab_menu(needle, tab_entries, separator):
    """Print tab completion menu with entries.

    Args:
        needle: Search needle.
        tab_entries: List of tab completion entries.
        separator: Separator character.
    """
    if not tab_entries:
        return

    # Calculate column widths
    num_entries = len(tab_entries)
    if num_entries <= 6:
        ncols = num_entries
    else:
        ncols = 6

    # Calculate index width
    max_index = len(str(num_entries))

    # Calculate path widths for each column
    col_widths = [0] * ncols
    for i, entry in enumerate(tab_entries):
        col = i % ncols
        info = get_tab_entry_info(entry, separator)
        path = info[2]
        width = len(path) + max_index + 2  # index + space padding
        if width > col_widths[col]:
            col_widths[col] = width

    # Total width of the menu
    total_width = sum(col_widths) + (ncols - 1) * 2  # 2 spaces between columns

    # Print header
    print_local('')
    header = '{:>12s}  {}'.format('#', needle)
    print_local(header)
    print_local('-' * max(len(header), total_width))

    # Print entries
    rows = (num_entries + ncols - 1) // ncols
    for row in range(rows):
        line_parts = []
        for col in range(ncols):
            idx = row + col * rows
            if idx >= num_entries:
                break
            entry = tab_entries[idx]
            info = get_tab_entry_info(entry, separator)
            needle_val, index_val, path_val = info
            formatted = '{:>{width}s}  {}'.format(
                index_val, path_val, width=max_index
            )
            line_parts.append(formatted)

        # Pad parts to column widths
        for col_idx, part in enumerate(line_parts):
            if col_idx < len(line_parts) - 1:
                padding = col_widths[col_idx] - len(part)
                if padding > 0:
                    line_parts[col_idx] = part + ' ' * max(padding, 2)
            else:
                # Last part, just ensure some trailing space
                pass

        print_local(''.join(line_parts))

    print_local('')


__all__ = [
    'create_dir',
    'encode_local',
    'get_tab_entry_info',
    'has_uppercase',
    'is_python2',
    'is_python3',
    'print_local',
    'print_tab_menu',
    'second',
    'surround_quotes',
    'unico',
    'get_pwd',
    'sanitize',
    'print_entry',
    'move_file',
    'in_bash',
    'is_autojump_sourced',
    'first',
    'last',
    'take',
    'is_linux',
    'is_osx',
    'is_windows',
]
