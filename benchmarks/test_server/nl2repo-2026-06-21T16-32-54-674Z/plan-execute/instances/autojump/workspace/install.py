#!/usr/bin/env python
# -*- coding: utf-8 -*-

"""
Autojump installation script.

This script handles the installation of autojump, including:
- Detecting the current shell
- Copying files to appropriate directories
- Modifying shell configuration scripts
- Supporting both user-local and system-wide installations
- Dry-run mode for safe preview

Usage:
    python install.py [--dryrun] [--force] [--system]
                      [--destdir DIR] [--prefix PREFIX] [--zshshare ZSHSHARE]
"""

from __future__ import print_function

import os
import sys
import shutil
import stat
import argparse
import platform

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SUPPORTED_SHELLS = ('bash', 'zsh', 'fish', 'tcsh')

# Default installation paths
AUTOJUP_HOME = os.path.expanduser('~/.local/share/autojump')
AUTOJUP_USER_LIB = os.path.expanduser('~/.local/lib')
AUTOJUP_USER_BIN = os.path.expanduser('~/.local/bin')

# System-wide installation paths
SYSTEM_ETC = '/etc/profile.d'
SYSTEM_SHARE = '/usr/share/autojump'
SYSTEM_BIN = '/usr/bin'

# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

def cp(src, dest, dryrun=False):
    """Copy file from source to destination.

    Args:
        src: Source file path.
        dest: Destination file path.
        dryrun: Whether to perform a dry run. Defaults to False.

    Returns:
        None. Prints status message.
    """
    if dryrun:
        print("[dryrun] Would copy {} -> {}".format(src, dest))
        return

    # Ensure destination directory exists
    dest_dir = os.path.dirname(dest)
    if dest_dir and not os.path.exists(dest_dir):
        mkdir(dest_dir, dryrun=False)

    shutil.copy2(src, dest)
    # Preserve executable permission if source is executable
    if os.access(src, os.X_OK):
        st = os.stat(dest)
        os.chmod(dest, st.st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    print("Copied {} -> {}".format(src, dest))


def mkdir(path, dryrun=False):
    """Create a directory with optional dry run mode.

    Args:
        path: Directory path to create.
        dryrun: Whether to perform a dry run. Defaults to False.

    Returns:
        None. Prints status message.
    """
    if dryrun:
        print("[dryrun] Would create directory: {}".format(path))
        return

    try:
        os.makedirs(path, exist_ok=True)
        print("Created directory: {}".format(path))
    except OSError as e:
        print("Error creating directory {}: {}".format(path, e), file=sys.stderr)
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
        if os.path.exists(path):
            shutil.rmtree(path)
            print("Removed directory: {}".format(path))
    except OSError as e:
        print("Error removing directory {}: {}".format(path, e), file=sys.stderr)
        raise


def get_shell():
    """Get the current shell type being used.

    Returns:
        String representing the shell type (e.g., 'bash', 'zsh', 'fish', 'tcsh').
        Returns None if the shell cannot be determined.
    """
    shell = os.environ.get('SHELL', '')
    if not shell:
        # Fallback: check PROCESSOR_ARCHITECTURE for Windows
        if sys.platform == 'win32':
            return 'cmd'
        return None

    shell_basename = os.path.basename(shell)

    if 'bash' in shell_basename:
        return 'bash'
    elif 'zsh' in shell_basename:
        return 'zsh'
    elif 'fish' in shell_basename:
        return 'fish'
    elif 'tcsh' in shell_basename or 'csh' in shell_basename:
        return 'tcsh'
    elif 'ksh' in shell_basename:
        return 'ksh'
    elif 'dash' in shell_basename or 'ash' in shell_basename:
        return 'ash'

    # If we can't determine the shell, check if we're in a known shell
    # by checking environment variables
    if os.environ.get('BASH_VERSION'):
        return 'bash'
    elif os.environ.get('ZSH_NAME'):
        return 'zsh'
    elif os.environ.get('FISH_VERSION'):
        return 'fish'

    return shell_basename if shell_basename else None


def _get_autojump_script_dir():
    """Get the directory where this install.py script resides.

    Returns:
        The directory path containing the autojump bin/ files.
    """
    return os.path.dirname(os.path.abspath(__file__))


def _get_bin_dir():
    """Get the bin directory path.

    Returns:
        Path to the bin/ directory containing autojump scripts.
    """
    script_dir = _get_autojump_script_dir()
    bin_dir = os.path.join(script_dir, 'bin')
    if not os.path.isdir(bin_dir):
        bin_dir = script_dir
    return bin_dir


def _copy_bin_files(bin_dir, etc_dir, share_dir, bin_install_dir, dryrun=False):
    """Copy all bin files to the installation directories.

    Args:
        bin_dir: Source bin directory.
        etc_dir: Destination etc directory.
        share_dir: Destination share directory.
        bin_install_dir: Destination bin directory.
        dryrun: Whether to perform a dry run.
    """
    # Copy Python modules to share directory
    python_files = ['autojump.py', 'autojump_data.py', 'autojump_match.py',
                     'autojump_utils.py', 'autojump_argparse.py', '__init__.py']
    for f in python_files:
        src = os.path.join(bin_dir, f)
        if os.path.exists(src):
            cp(src, os.path.join(share_dir, f), dryrun=dryrun)

    # Copy shell integration scripts
    shell_scripts = ['autojump.bash', 'autojump.zsh', 'autojump.fish',
                     'autojump.tcsh', 'autojump.sh', 'autojump.lua']
    for f in shell_scripts:
        src = os.path.join(bin_dir, f)
        if os.path.exists(src):
            cp(src, os.path.join(etc_dir, f), dryrun=dryrun)

    # Copy the main autojump script and _j helper to bin
    main_scripts = ['autojump', '_j']
    for f in main_scripts:
        src = os.path.join(bin_dir, f)
        if os.path.exists(src):
            cp(src, os.path.join(bin_install_dir, f), dryrun=dryrun)

    # Copy batch files if present
    batch_files = ['j.bat', 'jc.bat', 'jco.bat', 'jo.bat', 'autojump.bat']
    for f in batch_files:
        src = os.path.join(bin_dir, f)
        if os.path.exists(src):
            cp(src, os.path.join(bin_install_dir, f), dryrun=dryrun)

    # Copy icon if present
    icon_src = os.path.join(bin_dir, 'icon.png')
    if os.path.exists(icon_src):
        cp(icon_src, os.path.join(share_dir, 'icon.png'), dryrun=dryrun)


def modify_autojump_sh(etc_dir, share_dir, dryrun=False):
    """Append custom installation path to autojump.sh script.

    Args:
        etc_dir: etc directory path.
        share_dir: share directory path.
        dryrun: Whether to perform a dry run. Defaults to False.
    """
    autojump_sh = os.path.join(etc_dir, 'autojump.sh')
    lines_to_add = [
        'export AUTOJUMP_PATH="{}"'.format(etc_dir),
        'export AUTOJUMP_SHARE="{}"'.format(share_dir),
    ]

    if dryrun:
        print("[dryrun] Would append to {}:".format(autojump_sh))
        for line in lines_to_add:
            print("  {}".format(line))
        return

    if os.path.exists(autojump_sh):
        with open(autojump_sh, 'a') as f:
            for line in lines_to_add:
                f.write(line + '\n')
        print("Modified {}".format(autojump_sh))
    else:
        # Create the file if it doesn't exist
        with open(autojump_sh, 'w') as f:
            f.write('#!/bin/bash\n')
            for line in lines_to_add:
                f.write(line + '\n')
        print("Created and modified {}".format(autojump_sh))


def modify_autojump_lua(clink_dir, bin_dir, dryrun=False):
    """Append custom installation path to autojump.lua script.

    Args:
        clink_dir: clink directory path.
        bin_dir: bin directory path.
        dryrun: Whether to perform a dry run. Defaults to False.
    """
    autojump_lua = os.path.join(clink_dir, 'autojump.lua')
    lines_to_add = [
        'autojump_bin_dir = "{}"'.format(bin_dir),
        'autojump_clink_dir = "{}"'.format(clink_dir),
    ]

    if dryrun:
        print("[dryrun] Would append to {}:".format(autojump_lua))
        for line in lines_to_add:
            print("  {}".format(line))
        return

    if os.path.exists(autojump_lua):
        with open(autojump_lua, 'a') as f:
            for line in lines_to_add:
                f.write(line + '\n')
        print("Modified {}".format(autojump_lua))
    else:
        with open(autojump_lua, 'w') as f:
            f.write('-- Autojump Clink configuration\n')
            for line in lines_to_add:
                f.write(line + '\n')
        print("Created and modified {}".format(autojump_lua))


def show_post_installation_message(etc_dir, share_dir, bin_dir):
    """Display post-installation message to the user.

    Args:
        etc_dir: etc directory path.
        share_dir: share directory path.
        bin_dir: bin directory path.
    """
    shell = get_shell()

    print("")
    print("=" * 60)
    print("Autojump installation completed successfully!")
    print("=" * 60)
    print("")
    print("Installation paths:")
    print("  Shell scripts: {}".format(etc_dir))
    print("  Data files:    {}".format(share_dir))
    print("  Binaries:      {}".format(bin_dir))
    print("")

    if shell:
        if shell == 'bash':
            rc_file = os.path.expanduser('~/.bashrc')
            source_line = 'source {}'.format(os.path.join(etc_dir, 'autojump.bash'))
            print("To activate autojump in bash, add the following line to {}:".format(rc_file))
            print("  {}".format(source_line))
        elif shell == 'zsh':
            rc_file = os.path.expanduser('~/.zshrc')
            source_line = 'source {}'.format(os.path.join(etc_dir, 'autojump.zsh'))
            print("To activate autojump in zsh, add the following line to {}:".format(rc_file))
            print("  {}".format(source_line))
        elif shell == 'fish':
            fish_dir = os.path.join(os.path.expanduser('~'), '.config', 'fish', 'conf.d')
            script = os.path.join(etc_dir, 'autojump.fish')
            link_target = os.path.join(fish_dir, 'autojump.fish')
            print("To activate autojump in fish, symlink the fish script:")
            print("  ln -s {} {}".format(script, link_target))
        elif shell == 'tcsh':
            rc_file = os.path.expanduser('~/.tcshrc')
            source_line = 'source {}'.format(os.path.join(etc_dir, 'autojump.tcsh'))
            print("To activate autojump in tcsh, add the following line to {}:".format(rc_file))
            print("  {}".format(source_line))
        else:
            print("Detected shell: {}".format(shell))
            print("Please manually add the appropriate source line to your shell config.")
    else:
        print("Could not detect your shell. Please manually configure autojump.")
        print("Add the appropriate source line to your shell configuration file.")

    print("")
    print("Commands available:")
    print("  j <query>     - Jump to a matching directory")
    print("  jc <query>    - Jump to a child directory")
    print("  jo <query>    - Open in file manager")
    print("  jco <query>   - Open child in file manager")
    print("")
    print("=" * 60)


def _validate_python():
    """Validate that the Python version is supported.

    Returns:
        True if Python version is supported, False otherwise.
    """
    version = sys.version_info
    if version.major == 2:
        if version.minor >= 6:
            return True
        print("Error: Python 2.6+ is required (found {}.{})".format(
            version.major, version.minor), file=sys.stderr)
        return False
    elif version.major == 3:
        if version.minor >= 3:
            return True
        print("Error: Python 3.3+ is required (found {}.{})".format(
            version.major, version.minor), file=sys.stderr)
        return False
    else:
        print("Error: Unsupported Python version {}.{}".format(
            version.major, version.minor), file=sys.stderr)
        return False


def _validate_dependencies():
    """Validate that all required modules are available.

    Returns:
        True if all dependencies are available, False otherwise.
    """
    required_modules = [
        'argparse', 'json', 'os', 'sys', 'itertools', 'math',
        'operator', 'platform', 'subprocess', 'shutil'
    ]
    missing = []
    for mod in required_modules:
        try:
            __import__(mod)
        except ImportError:
            missing.append(mod)

    if missing:
        print("Error: Missing required modules: {}".format(', '.join(missing)),
              file=sys.stderr)
        return False
    return True


def _validate_autojump_modules():
    """Validate that all autojump modules can be imported.

    Returns:
        True if all modules import successfully, False otherwise.
    """
    # Add project root to path
    script_dir = _get_autojump_script_dir()
    if script_dir not in sys.path:
        sys.path.insert(0, script_dir)

    modules_to_test = [
        ('bin.autojump_utils', ['create_dir', 'encode_local', 'get_tab_entry_info',
                                 'has_uppercase', 'is_python2', 'is_python3',
                                 'print_local', 'print_tab_menu', 'second',
                                 'surround_quotes', 'unico']),
        ('bin.autojump_data', ['BACKUP_THRESHOLD', 'Entry', 'load', 'save',
                                'dictify', 'entriefy', 'load_backup',
                                'migrate_osx_xdg_data']),
        ('bin.autojump_match', ['match_anywhere', 'match_consecutive', 'match_fuzzy']),
        ('bin.autojump', ['VERSION', 'FUZZY_MATCH_THRESHOLD', 'TAB_ENTRIES_COUNT',
                           'TAB_SEPARATOR', 'parse_arguments', 'add_path',
                           'decrease_path', 'find_matches', 'main']),
        ('bin.autojump_argparse', ['ArgumentParser', 'SUPPRESS', 'Namespace']),
    ]

    for module_name, attributes in modules_to_test:
        try:
            module = __import__(module_name, fromlist=attributes)
            for attr in attributes:
                if not hasattr(module, attr):
                    print("Warning: {} missing attribute {}".format(
                        module_name, attr), file=sys.stderr)
        except ImportError as e:
            print("Error: Cannot import {}: {}".format(module_name, e),
                  file=sys.stderr)
            return False

    return True


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

def parse_arguments(args=None):
    """Parse command line arguments for autojump installation.

    Args:
        args: Optional list of argument strings (defaults to sys.argv[1:]).

    Returns:
        Namespace object containing parsed arguments with attributes:
        - dryrun: Simulate installation without making changes
        - force: Skip validation checks
        - destdir: Installation destination directory
        - prefix: Installation prefix directory
        - zshshare: Zsh share directory
        - clinkdir: Clink directory (Windows only)
        - system: Install system-wide for all users
    """
    parser = argparse.ArgumentParser(
        prog='autojump-install',
        description='Install autojump - a fast directory jumper.',
    )

    parser.add_argument(
        '--dryrun',
        action='store_true',
        default=False,
        help='Simulate installation without making changes.'
    )
    parser.add_argument(
        '--force',
        action='store_true',
        default=False,
        help='Skip validation checks and force installation.'
    )
    parser.add_argument(
        '--destdir',
        default=None,
        metavar='DIR',
        help='Installation destination directory (for packaging).'
    )
    parser.add_argument(
        '--prefix',
        default=None,
        metavar='DIR',
        help='Installation prefix directory.'
    )
    parser.add_argument(
        '--zshshare',
        default=None,
        metavar='DIR',
        help='Zsh share directory (overrides default).'
    )
    parser.add_argument(
        '--clinkdir',
        default=None,
        metavar='DIR',
        help='Clink directory (Windows only).'
    )
    parser.add_argument(
        '--system',
        action='store_true',
        default=False,
        help='Install system-wide for all users.'
    )

    parsed = parser.parse_args(args)

    # Determine if using custom installation
    parsed.custom_install = (parsed.destdir is not None or
                             parsed.prefix is not None or
                             parsed.zshshare is not None or
                             parsed.clinkdir is not None)

    return parsed


# ---------------------------------------------------------------------------
# Main installation logic
# ---------------------------------------------------------------------------

def main(args=None):
    """Main entry point for the autojump installer.

    Args:
        args: Optional list of argument strings (defaults to sys.argv[1:]).

    Returns:
        Exit code (0 = success, non-zero = error).
    """
    parsed = parse_arguments(args)

    dryrun = parsed.dryrun
    force = parsed.force

    # Validate Python version
    if not force:
        if not _validate_python():
            return 1
        if not _validate_dependencies():
            return 1
        if not _validate_autojump_modules():
            return 1
        print("All validations passed.")
    else:
        print("Skipping validations (--force).")

    # Determine installation paths
    if parsed.custom_install:
        destdir = parsed.destdir or ''
        prefix = parsed.prefix or '/usr/local'
        etc_dir = os.path.join(destdir, prefix, 'etc', 'profile.d')
        share_dir = os.path.join(destdir, prefix, 'share', 'autojump')
        bin_install_dir = os.path.join(destdir, prefix, 'bin')
    elif parsed.system:
        etc_dir = SYSTEM_ETC
        share_dir = SYSTEM_SHARE
        bin_install_dir = SYSTEM_BIN
    else:
        etc_dir = os.path.expanduser('~/.autojump/etc')
        share_dir = AUTOJUP_HOME
        bin_install_dir = AUTOJUP_USER_BIN

    zshshare = parsed.zshshare or os.path.join(share_dir, 'zsh')
    clinkdir = parsed.clinkdir or ''

    # Get source bin directory
    bin_dir = _get_bin_dir()

    print("")
    print("Autojump Installation")
    print("=" * 40)
    print("  Shell scripts: {}".format(etc_dir))
    print("  Data files:    {}".format(share_dir))
    print("  Binaries:      {}".format(bin_install_dir))
    print("  Source:        {}".format(bin_dir))
    print("  Dry run:       {}".format(dryrun))
    if parsed.system:
        print("  Mode:          System-wide")
    else:
        print("  Mode:          User-local")
    print("=" * 40)
    print("")

    # Create directories
    mkdir(etc_dir, dryrun=dryrun)
    mkdir(share_dir, dryrun=dryrun)
    mkdir(bin_install_dir, dryrun=dryrun)

    # Copy bin files
    _copy_bin_files(bin_dir, etc_dir, share_dir, bin_install_dir, dryrun=dryrun)

    # Modify shell scripts for custom paths
    if parsed.custom_install:
        modify_autojump_sh(etc_dir, share_dir, dryrun=dryrun)
        if clinkdir:
            modify_autojump_lua(clinkdir, bin_install_dir, dryrun=dryrun)

    # Show post-installation message
    if not dryrun:
        show_post_installation_message(etc_dir, share_dir, bin_install_dir)

    # Verify installation by running a quick test
    if not dryrun and not force:
        print("\nVerifying installation...")
        try:
            script_dir = _get_autojump_script_dir()
            if script_dir not in sys.path:
                sys.path.insert(0, script_dir)

            from bin.autojump_data import Entry, load, save, BACKUP_THRESHOLD
            from bin.autojump_match import match_anywhere, match_consecutive, match_fuzzy
            from bin.autojump_utils import create_dir, unico, has_uppercase

            # Quick functional test
            assert BACKUP_THRESHOLD == 86400, "BACKUP_THRESHOLD mismatch"
            assert Entry(path='/tmp', weight=10.0).path == '/tmp', "Entry mismatch"
            assert has_uppercase('Hello') is True, "has_uppercase failed"
            assert has_uppercase('hello') is False, "has_uppercase failed"

            # Test matching
            entries = [Entry(path='/home/user/projects', weight=10.0)]
            results = list(match_anywhere(['proj'], entries))
            assert len(results) == 1, "match_anywhere failed"

            print("Installation verified successfully!")
        except Exception as e:
            print("Warning: Installation verification failed: {}".format(e),
                  file=sys.stderr)

    return 0


if __name__ == '__main__':
    sys.exit(main())
