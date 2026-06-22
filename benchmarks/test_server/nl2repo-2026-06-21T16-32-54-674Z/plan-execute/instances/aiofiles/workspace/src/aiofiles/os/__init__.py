"""Asynchronous OS file system operations for aiofiles.

This module provides async versions of common os module functions,
delegating blocking I/O operations to a thread pool executor.
"""

import os
import sys

from aiofiles.base import wrap as wrap_func


# Re-export os.path as path
path = os.path


__all__ = [
    "path",
    "stat",
    "rename",
    "renames",
    "replace",
    "remove",
    "unlink",
    "mkdir",
    "makedirs",
    "rmdir",
    "removedirs",
    "symlink",
    "readlink",
    "link",
    "listdir",
    "scandir",
    "access",
    "wrap",
    "getcwd",
]


# File status query
stat = wrap_func(os.stat)


# File movement
rename = wrap_func(os.rename)
renames = wrap_func(os.renames)
replace = wrap_func(os.replace)


# File deletion
remove = wrap_func(os.remove)
unlink = wrap_func(os.unlink)


# Directory operations
mkdir = wrap_func(os.mkdir)
makedirs = wrap_func(os.makedirs)
rmdir = wrap_func(os.rmdir)
removedirs = wrap_func(os.removedirs)


# Symbolic link operations
symlink = wrap_func(os.symlink)
readlink = wrap_func(os.readlink)

# Hard link (not available on all platforms)
if hasattr(os, "link"):
    link = wrap_func(os.link)
else:
    link = None  # type: ignore[assignment]


# Directory traversal
listdir = wrap_func(os.listdir)
scandir = wrap_func(os.scandir)


# File access check
access = wrap_func(os.access)


# Current working directory
getcwd = wrap_func(os.getcwd)


def wrap(func):
    """Wrap a synchronous os function to run asynchronously via a thread pool.

    This is a convenience wrapper equivalent to the base.wrap decorator,
    provided here for os-specific usage.

    Args:
        func: The synchronous function to wrap.

    Returns:
        An async wrapper that executes the function in a thread pool.
    """
    return wrap_func(func)
