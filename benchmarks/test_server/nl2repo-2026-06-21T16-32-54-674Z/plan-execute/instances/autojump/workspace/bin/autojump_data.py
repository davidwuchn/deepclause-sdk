"""
autojump_data.py - Directory database management for the Autojump project.

Provides functions for loading, saving, and managing the directory
database including Entry namedtuple, backup support, and data migration.
"""

import os
import sys
import json
import time
import shutil
import tempfile
from collections import namedtuple

from bin.autojump_utils import (
    create_dir,
    is_python3,
    is_osx,
    is_windows,
    is_linux,
    move_file,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

BACKUP_THRESHOLD = 24 * 60 * 60  # 24 hours in seconds

# Entry namedtuple: stores directory path and its associated weight
Entry = namedtuple('Entry', ['path', 'weight'])


# ---------------------------------------------------------------------------
# Default data paths per platform
# ---------------------------------------------------------------------------

def _get_default_data_path():
    """Get the default autojump data file path based on platform."""
    if is_osx():
        return os.path.expanduser("~/Library/autojump/autojump.txt")
    elif is_windows():
        return os.path.join(os.environ.get('APPDATA', os.path.expanduser("~/AppData/Roaming")),
                            'autojump', 'autojump.txt')
    else:
        # Linux / other Unix
        return os.path.expanduser("~/.local/share/autojump/autojump.txt")


def _get_default_backup_path(data_path):
    """Get the backup file path derived from the data path."""
    return data_path + '.bak'


# ---------------------------------------------------------------------------
# Internal helpers for I/O compatibility
# ---------------------------------------------------------------------------

def _open_file(path, mode='r'):
    """Open a file with the appropriate mode and encoding.

    Handles Python 2 vs 3 differences for text vs binary mode.
    """
    if is_python3():
        return open(path, mode, encoding='utf-8', errors='replace')
    else:
        return open(path, mode)


# ---------------------------------------------------------------------------
# Core load / save functions
# ---------------------------------------------------------------------------

def load(config):
    """Load the directory database from the data file.

    Reads a text file where each line has the format:
        path<TAB>weight

    Args:
        config (dict): Configuration dictionary with keys:
            - data_path (str): Path to the autojump data file.

    Returns:
        dict: A dictionary mapping path (str) -> Entry(path, weight).
              Returns an empty dict if the file does not exist or cannot
              be read.
    """
    data_path = config.get('data_path', _get_default_data_path())
    data = {}

    if not os.path.isfile(data_path):
        return data

    try:
        with _open_file(data_path, 'r') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                # Format: path\tweight
                sep_idx = line.find('\t')
                if sep_idx == -1:
                    continue
                path = line[:sep_idx]
                weight_str = line[sep_idx + 1:]
                try:
                    weight = float(weight_str)
                except ValueError:
                    continue
                data[path] = Entry(path=path, weight=weight)
    except (IOError, OSError):
        # If we can't read the file, try the backup
        try:
            backup_path = config.get('backup_path', _get_default_backup_path(data_path))
            if os.path.isfile(backup_path):
                config['data_path'] = backup_path
                data = load(config)
        except (IOError, OSError):
            pass

    return data


def save(config, data):
    """Atomically save directory entry data to the data file and create a backup.

    Writes each entry as a line in the format:
        path<TAB>weight

    The write is atomic: data is first written to a temporary file, then
    moved into place. A backup of the previous data file is created if
    the backup is older than BACKUP_THRESHOLD or does not exist.

    Args:
        config (dict): Configuration dictionary with keys:
            - data_path (str): Path to the autojump data file.
            - backup_path (str, optional): Path to the backup file.
        data (dict): Dictionary mapping path (str) -> Entry(path, weight)
                     or path (str) -> weight (float).

    Raises:
        IOError: If the data cannot be written.
    """
    data_path = config.get('data_path', _get_default_data_path())
    backup_path = config.get('backup_path', _get_default_backup_path(data_path))

    # Ensure parent directory exists
    data_dir = os.path.dirname(data_path)
    if data_dir:
        create_dir(data_dir)

    # Create backup if needed
    _create_backup(data_path, backup_path)

    # Write atomically via a temporary file
    tmp_fd = None
    tmp_path = None
    try:
        tmp_fd, tmp_path = tempfile.mkstemp(
            dir=data_dir, prefix='.autojump_tmp_', suffix='.txt'
        )
        if is_python3():
            tmp_file = os.fdopen(tmp_fd, 'w', encoding='utf-8')
            tmp_fd = None  # os.fdopen takes ownership of the fd
        else:
            tmp_file = os.fdopen(tmp_fd, 'w')
            tmp_fd = None

        for path, value in sorted(data.items()):
            if isinstance(value, Entry):
                weight = value.weight
            else:
                weight = value
            tmp_file.write('{path}\t{weight}\n'.format(path=path, weight=weight))

        tmp_file.close()

        # Set same permissions as original if it exists
        if os.path.isfile(data_path):
            try:
                st = os.stat(data_path)
                os.chmod(tmp_path, st.st_mode)
            except OSError:
                pass

        # Atomically move temp file into place
        if is_windows():
            # Windows rename is not always atomic; remove first
            try:
                os.remove(data_path)
            except OSError:
                pass
            shutil.move(tmp_path, data_path)
        else:
            os.rename(tmp_path, data_path)
        tmp_path = None  # successfully moved, don't clean up
    except Exception:
        if tmp_fd is not None:
            try:
                os.close(tmp_fd)
            except OSError:
                pass
        if tmp_path is not None:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        raise
    finally:
        if tmp_fd is not None:
            try:
                os.close(tmp_fd)
            except OSError:
                pass


def _create_backup(data_path, backup_path):
    """Create a backup of the data file if needed.

    A backup is created if:
    - The backup file does not exist, or
    - The backup file is older than BACKUP_THRESHOLD seconds, or
    - The data file is newer than the backup file.
    """
    if not os.path.isfile(data_path):
        return

    # Check if backup needs to be created
    if not os.path.isfile(backup_path):
        _do_backup(data_path, backup_path)
        return

    try:
        backup_mtime = os.stat(backup_path).st_mtime
        data_mtime = os.stat(data_path).st_mtime
    except OSError:
        return

    if data_mtime > backup_mtime:
        age = time.time() - backup_mtime
        if age > BACKUP_THRESHOLD:
            _do_backup(data_path, backup_path)


def _do_backup(data_path, backup_path):
    """Actually copy the data file to the backup path."""
    backup_dir = os.path.dirname(backup_path)
    if backup_dir:
        create_dir(backup_dir)
    try:
        shutil.copy2(data_path, backup_path)
    except (IOError, OSError):
        pass


# ---------------------------------------------------------------------------
# Conversion helpers
# ---------------------------------------------------------------------------

def dictify(entries):
    """Convert a list of Entry objects into a dictionary.

    Args:
        entries (list): List of Entry(path, weight) objects.

    Returns:
        dict: Dictionary mapping path -> Entry.
    """
    return {entry.path: entry for entry in entries}


def entriefy(data):
    """Convert a dictionary into an iterator of Entry objects.

    Args:
        data (dict): Dictionary mapping path -> Entry or path -> weight.

    Returns:
        iterator: Iterator of Entry(path, weight) objects.
    """
    for path, value in data.items():
        if isinstance(value, Entry):
            yield value
        else:
            yield Entry(path=path, weight=float(value))


# ---------------------------------------------------------------------------
# Backup loading
# ---------------------------------------------------------------------------

def load_backup(config):
    """Load data from the backup file.

    Args:
        config (dict): Configuration dictionary with keys:
            - data_path (str): Path to the autojump data file.
            - backup_path (str, optional): Path to the backup file.

    Returns:
        dict: Dictionary mapping path -> Entry(path, weight).
              Returns an empty dict if the backup cannot be read.
    """
    data_path = config.get('data_path', _get_default_data_path())
    backup_path = config.get('backup_path', _get_default_backup_path(data_path))

    if not os.path.isfile(backup_path):
        return {}

    backup_config = dict(config)
    backup_config['data_path'] = backup_path
    return load(backup_config)


# ---------------------------------------------------------------------------
# Data migration
# ---------------------------------------------------------------------------

def migrate_osx_xdg_data(config):
    """Migrate macOS XDG data to the standard autojump data location.

    On macOS, some installations may have stored data in an XDG-style
    location (~/.local/share/autojump/) instead of the standard macOS
    location (~/Library/autojump/). This function migrates that data
    to the correct location if the target does not already exist.

    Args:
        config (dict): Configuration dictionary with keys:
            - data_path (str): Path to the autojump data file.
    """
    if not is_osx():
        return

    old_data_path = os.path.expanduser("~/.local/share/autojump/autojump.txt")
    data_path = config.get('data_path', _get_default_data_path())

    # If the new path is the same as the old path, nothing to migrate
    if os.path.abspath(old_data_path) == os.path.abspath(data_path):
        return

    # If the new location already has data, don't overwrite
    if os.path.isfile(data_path):
        return

    # If old data doesn't exist, nothing to migrate
    if not os.path.isfile(old_data_path):
        return

    # Migrate: copy old data to new location
    data_dir = os.path.dirname(data_path)
    if data_dir:
        create_dir(data_dir)

    try:
        shutil.copy2(old_data_path, data_path)
    except (IOError, OSError):
        pass

    # Optionally remove the old data
    try:
        os.remove(old_data_path)
        # Clean up empty parent dirs
        old_dir = os.path.dirname(old_data_path)
        if old_dir and os.path.isdir(old_dir):
            try:
                os.rmdir(old_dir)
            except OSError:
                pass
            grandparent = os.path.dirname(old_dir)
            if grandparent and os.path.isdir(grandparent):
                try:
                    os.rmdir(grandparent)
                except OSError:
                    pass
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Module-level exports
# ---------------------------------------------------------------------------

__all__ = [
    'BACKUP_THRESHOLD',
    'Entry',
    'load',
    'save',
    'dictify',
    'entriefy',
    'load_backup',
    'migrate_osx_xdg_data',
]
