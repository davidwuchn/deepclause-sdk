#!/usr/bin/env python
# -*- coding: utf-8 -*-

"""
Autojump uninstallation script.

This script handles the removal of autojump, including:
- Removing installed files and directories
- Supporting custom, user-local, and system-wide removals
- Optionally removing user data files
- Dry-run mode for safe preview

Usage:
    python uninstall.py [--dryrun] [--userdata]
                        [--destdir DIR] [--prefix PREFIX] [--zshshare ZSHSHARE]
                        [--clinkdir CLINKDIR]
"""

from __future__ import print_function

import os
import sys
import shutil
import argparse

# ---------------------------------------------------------------------------
# Constants – mirror paths from install.py
# ---------------------------------------------------------------------------

# Default user-local installation paths
AUTOJUP_HOME = os.path.expanduser('~/.local/share/autojump')
AUTOJUP_USER_LIB = os.path.expanduser('~/.local/lib')
AUTOJUP_USER_BIN = os.path.expanduser('~/.local/bin')

# System-wide installation paths
SYSTEM_ETC = '/etc/profile.d'
SYSTEM_SHARE = '/usr/share/autojump'
SYSTEM_BIN = '/usr/bin'

# User data locations (cross-platform)
DATA_PATHS = [
    os.path.expanduser('~/.local/share/autojump/autojump.txt'),
    os.path.expanduser('~/.local/share/autojump/autojump.txt.bak'),
]
if sys.platform == 'darwin':
    DATA_PATHS += [
        os.path.expanduser('~/Library/autojump/autojump.txt'),
        os.path.expanduser('~/Library/autojump/autojump.txt.bak'),
    ]
if sys.platform == 'win32':
    data_dir = os.path.expanduser('~/.autojump')
    DATA_PATHS += [
        os.path.join(data_dir, 'autojump.txt'),
        os.path.join(data_dir, 'autojump.txt.bak'),
    ]


# ---------------------------------------------------------------------------
# File / directory helpers
# ---------------------------------------------------------------------------

def rm(path, dryrun=False):
    """Remove a file.

    Args:
        path: File path to remove.
        dryrun: Whether to perform a dry run. Defaults to False.

    Returns:
        None. Prints status message.
    """
    if dryrun:
        print("[dryrun] Would remove file: {}".format(path))
        return

    try:
        if os.path.exists(path):
            os.remove(path)
            print("Removed file: {}".format(path))
    except OSError as e:
        print("Error removing file {}: {}".format(path, e), file=sys.stderr)
        raise


def rmdir(path, dryrun=False):
    """Remove a directory with optional dry run mode.

    Args:
        path: Directory path to remove.
        dryrun: Whether to perform a dry run.

    Returns:
        None. Prints status message.
    """
    if dryrun:
        print("[dryrun] Would remove directory: {}".format(path))
        return

    try:
        if os.path.isdir(path):
            shutil.rmtree(path)
            print("Removed directory: {}".format(path))
    except OSError as e:
        print("Error removing directory {}: {}".format(path, e), file=sys.stderr)
        raise


def is_empty_dir(path):
    """Check if a directory is empty.

    Args:
        path: Directory path to check.

    Returns:
        Boolean indicating if directory is empty.
        Returns False if the path does not exist or is not a directory.
    """
    try:
        if not os.path.isdir(path):
            return False
        return len(os.listdir(path)) == 0
    except OSError:
        return False


# ---------------------------------------------------------------------------
# Remove specific files
# ---------------------------------------------------------------------------

def _remove_file_if_exists(path, dryrun=False):
    """Remove a file only if it exists, without raising on missing files."""
    if os.path.isfile(path):
        rm(path, dryrun=dryrun)


def _remove_scripts_from_dir(directory, dryrun=False):
    """Remove all autojump-related scripts from a given directory."""
    scripts = [
        'autojump.bash', 'autojump.zsh', 'autojump.fish',
        'autojump.tcsh', 'autojump.sh', 'autojump.lua',
    ]
    for name in scripts:
        _remove_file_if_exists(os.path.join(directory, name), dryrun=dryrun)


def _remove_bin_from_dir(directory, dryrun=False):
    """Remove autojump binaries from a bin directory."""
    binaries = [
        'autojump', '_j',
        'j.bat', 'jc.bat', 'jco.bat', 'jo.bat', 'autojump.bat',
    ]
    for name in binaries:
        _remove_file_if_exists(os.path.join(directory, name), dryrun=dryrun)


def _remove_share_from_dir(directory, dryrun=False):
    """Remove autojump share (Python module) files from a directory."""
    share_files = [
        'autojump.py', 'autojump_data.py', 'autojump_match.py',
        'autojump_utils.py', 'autojump_argparse.py', '__init__.py',
        'icon.png',
    ]
    for name in share_files:
        _remove_file_if_exists(os.path.join(directory, name), dryrun=dryrun)


# ---------------------------------------------------------------------------
# Removal functions
# ---------------------------------------------------------------------------

def remove_custom_installation(args, dryrun=False):
    """Remove custom installation of autojump.

    Args:
        args: Parsed arguments namespace (expects `destdir`, `prefix`,
              `zshshare`, `clinkdir`).
        dryrun: Simulate actions without performing deletions.

    Returns:
        None.
    """
    destdir = getattr(args, 'destdir', '') or ''
    prefix = getattr(args, 'prefix', '/usr/local') or '/usr/local'
    zshshare = getattr(args, 'zshshare', None)
    clinkdir = getattr(args, 'clinkdir', None)

    etc_dir = os.path.join(destdir, prefix, 'etc', 'profile.d')
    share_dir = os.path.join(destdir, prefix, 'share', 'autojump')
    bin_dir = os.path.join(destdir, prefix, 'bin')

    print("Removing custom installation...")
    print("  etc:    {}".format(etc_dir))
    print("  share:  {}".format(share_dir))
    print("  bin:    {}".format(bin_dir))

    # Remove scripts from etc
    _remove_scripts_from_dir(etc_dir, dryrun=dryrun)

    # Remove share files
    _remove_share_from_dir(share_dir, dryrun=dryrun)

    # Remove binaries
    _remove_bin_from_dir(bin_dir, dryrun=dryrun)

    # Remove zsh share if specified
    if zshshare and os.path.isdir(zshshare):
        rmdir(zshshare, dryrun=dryrun)

    # Remove clink dir files if specified
    if clinkdir:
        _remove_file_if_exists(os.path.join(clinkdir, 'autojump.lua'), dryrun=dryrun)

    # Clean up empty directories
    for d in [share_dir, etc_dir]:
        if os.path.isdir(d) and is_empty_dir(d):
            rmdir(d, dryrun=dryrun)

    print("Custom installation removed.")


def remove_system_installation(dryrun=False):
    """Remove system installation of autojump.

    Args:
        dryrun: Simulate actions without performing deletions.

    Returns:
        None.
    """
    print("Removing system-wide installation...")
    print("  etc:    {}".format(SYSTEM_ETC))
    print("  share:  {}".format(SYSTEM_SHARE))
    print("  bin:    {}".format(SYSTEM_BIN))

    # Remove scripts from /etc/profile.d
    _remove_scripts_from_dir(SYSTEM_ETC, dryrun=dryrun)

    # Remove entire system share directory
    if os.path.isdir(SYSTEM_SHARE):
        rmdir(SYSTEM_SHARE, dryrun=dryrun)
    else:
        _remove_share_from_dir(SYSTEM_SHARE, dryrun=dryrun)

    # Remove binaries from /usr/bin
    _remove_bin_from_dir(SYSTEM_BIN, dryrun=dryrun)

    print("System-wide installation removed.")


def remove_user_data(dryrun=False):
    """Remove user data files.

    Args:
        dryrun: Simulate actions without performing deletions.

    Returns:
        None.
    """
    print("Removing user data files...")

    data_dirs = set()
    for path in DATA_PATHS:
        if os.path.exists(path):
            rm(path, dryrun=dryrun)
            data_dirs.add(os.path.dirname(path))
        else:
            print("[skip]  Does not exist: {}".format(path))

    # Clean up empty data directories
    for d in data_dirs:
        if os.path.isdir(d) and is_empty_dir(d):
            rmdir(d, dryrun=dryrun)

    print("User data removal complete.")


def remove_user_installation(dryrun=False):
    """Remove user installation of autojump.

    Args:
        dryrun: Simulate actions without performing deletions.

    Returns:
        None.
    """
    print("Removing user-local installation...")

    user_etc = os.path.expanduser('~/.autojump/etc')
    user_share = AUTOJUP_HOME
    user_bin = AUTOJUP_USER_BIN

    print("  etc:    {}".format(user_etc))
    print("  share:  {}".format(user_share))
    print("  bin:    {}".format(user_bin))

    # Remove user etc scripts
    _remove_scripts_from_dir(user_etc, dryrun=dryrun)
    if os.path.isdir(user_etc) and is_empty_dir(user_etc):
        rmdir(user_etc, dryrun=dryrun)

    # Remove user share directory
    if os.path.isdir(user_share):
        rmdir(user_share, dryrun=dryrun)
    else:
        _remove_share_from_dir(user_share, dryrun=dryrun)

    # Remove user bin files
    _remove_bin_from_dir(user_bin, dryrun=dryrun)

    # Also remove ~/.autojump directory if it exists
    autojump_home = os.path.expanduser('~/.autojump')
    if os.path.isdir(autojump_home):
        if is_empty_dir(autojump_home):
            rmdir(autojump_home, dryrun=dryrun)
        else:
            # Remove autojump subfiles only
            for item in os.listdir(autojump_home):
                item_path = os.path.join(autojump_home, item)
                if os.path.isfile(item_path) and 'autojump' in item:
                    rm(item_path, dryrun=dryrun)

    print("User-local installation removed.")


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

def parse_arguments(args=None):
    """Parse command line arguments for autojump uninstallation.

    Args:
        args: Optional list of argument strings (defaults to sys.argv[1:]).

    Returns:
        Namespace object containing parsed arguments with attributes:
        - dryrun: Simulate uninstallation without making changes (bool)
        - userdata: Delete user data files (bool)
        - destdir: Custom destination directory to remove (str)
        - prefix: Custom prefix directory (str)
        - zshshare: Custom zsh share directory (str)
        - clinkdir: Clink directory (Windows only) (str)
    """
    parser = argparse.ArgumentParser(
        prog='autojump-uninstall',
        description='Uninstall autojump - a fast directory jumper.',
    )

    parser.add_argument(
        '--dryrun',
        action='store_true',
        default=False,
        help='Simulate uninstallation without making changes.',
    )
    parser.add_argument(
        '--userdata',
        action='store_true',
        default=False,
        help='Delete user data files (autojump.txt, backups).',
    )
    parser.add_argument(
        '--destdir',
        default=None,
        metavar='DIR',
        help='Custom destination directory to remove (for packaging).',
    )
    parser.add_argument(
        '--prefix',
        default=None,
        metavar='DIR',
        help='Custom prefix directory for removal.',
    )
    parser.add_argument(
        '--zshshare',
        default=None,
        metavar='DIR',
        help='Custom zsh share directory to remove.',
    )
    parser.add_argument(
        '--clinkdir',
        default=None,
        metavar='DIR',
        help='Clink directory to remove (Windows only).',
    )

    return parser.parse_args(args)


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def main(args=None):
    """Main entry point for the autojump uninstaller.

    Args:
        args: Optional list of argument strings (defaults to sys.argv[1:]).

    Returns:
        Exit code (0 = success, non-zero = error).
    """
    parsed = parse_arguments(args)

    dryrun = parsed.dryrun
    userdata = parsed.userdata
    custom = (parsed.destdir is not None or
              parsed.prefix is not None or
              parsed.zshshare is not None or
              parsed.clinkdir is not None)

    print("")
    print("Autojump Uninstallation")
    print("=" * 40)
    print("  Dry run:  {}".format(dryrun))
    print("  Remove user data: {}".format(userdata))
    if custom:
        print("  Mode:     Custom paths")
    else:
        print("  Mode:     User-local + System")
    print("=" * 40)
    print("")

    # Custom installation removal takes priority
    if custom:
        remove_custom_installation(parsed, dryrun=dryrun)
    else:
        # Remove system-wide installation
        if any(
            os.path.exists(os.path.join(SYSTEM_ETC, s))
            for s in ['autojump.bash', 'autojump.zsh', 'autojump.fish']
        ) or os.path.isdir(SYSTEM_SHARE):
            remove_system_installation(dryrun=dryrun)
        else:
            print("[skip]  No system-wide installation found.")

        # Remove user installation
        if any(
            os.path.exists(os.path.join(AUTOJUP_USER_BIN, b))
            for b in ['autojump', '_j']
        ) or os.path.isdir(AUTOJUP_HOME):
            remove_user_installation(dryrun=dryrun)
        else:
            print("[skip]  No user-local installation found.")

    # Remove user data if requested
    if userdata:
        remove_user_data(dryrun=dryrun)
    else:
        print("")
        print("[note]  User data files were NOT removed.")
        print("        To also delete your autojump database, run:")
        print("        python uninstall.py --userdata")

    print("")
    print("Uninstallation complete.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
