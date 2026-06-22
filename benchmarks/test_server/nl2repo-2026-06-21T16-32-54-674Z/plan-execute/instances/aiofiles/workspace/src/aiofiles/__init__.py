"""
aiofiles - Asynchronous file operations for Python.

This module provides asynchronous file operation interfaces, delegating
blocking file I/O operations to a thread pool executor to avoid blocking
the asyncio event loop.
"""

from aiofiles.threadpool import open
from aiofiles.threadpool import wrap
from aiofiles.threadpool import stdin, stdout, stderr
from aiofiles.threadpool import stdin_bytes, stdout_bytes, stderr_bytes
import aiofiles.tempfile as tempfile

__all__ = [
    "open",
    "wrap",
    "tempfile",
    "stdin",
    "stdout",
    "stderr",
    "stdin_bytes",
    "stdout_bytes",
    "stderr_bytes",
]
