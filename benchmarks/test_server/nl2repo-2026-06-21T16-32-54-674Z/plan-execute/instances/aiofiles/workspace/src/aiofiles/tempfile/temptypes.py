"""Asynchronous temporary file wrapper classes.

Provides ``AsyncSpooledTemporaryFile``, ``AsyncTemporaryDirectory``, and
``AiofilesContextManagerTempDir`` – the building blocks for the async
temporary-file factory functions in ``aiofiles.tempfile``.
"""

import asyncio

from aiofiles.base import AiofilesContextManager
from aiofiles.threadpool.utils import (
    cond_delegate_to_executor,
    delegate_to_executor,
    proxy_property_directly,
)


# ---------------------------------------------------------------------------
# AsyncSpooledTemporaryFile
# ---------------------------------------------------------------------------

@delegate_to_executor("fileno", "rollover")
@cond_delegate_to_executor(
    "close",
    "flush",
    "isatty",
    "read",
    "readline",
    "readlines",
    "seek",
    "tell",
    "truncate",
)
@proxy_property_directly("closed", "encoding", "mode", "name", "newlines")
class AsyncSpooledTemporaryFile:
    """Async wrapper for ``tempfile.SpooledTemporaryFile``.

    Wraps a ``tempfile.SpooledTemporaryFile`` instance.  While the
    spooled file is still buffered in memory, I/O operations are
    performed directly (they are fast).  Once the spooled file has
    *rolled over* to a real on-disk file, the blocking operations are
    dispatched to a thread-pool executor via ``self._loop.run_in_executor``.
    """

    def __init__(self, file, loop=None, executor=None):
        self._file = file
        self._executor = executor
        self._ref_loop = loop

    @property
    def _loop(self):
        """Return the event loop, falling back to the running loop."""
        return self._ref_loop or asyncio.get_running_loop()

    def __repr__(self):
        return f"{self.__class__.__name__} wrapping {self._file!r}"

    async def _check(self):
        """Check if the file has been rolled over to disk.

        Returns:
            bool: ``True`` if the underlying ``SpooledTemporaryFile`` has
                been rolled to a real file object on disk, ``False``
                otherwise.
        """
        return self._file._file is not None

    async def write(self, s):
        """Write data, anticipating a possible rollover.

        If the spooled file's in-memory buffer would exceed ``max_size``
        after this write, roll over to disk *before* delegating the write
        to the executor.

        Args:
            s: The string or bytes to write.

        Returns:
            int: The number of characters / bytes written.
        """
        import io

        # Check if we'll exceed max_size
        if self._file._file is None:
            pos = self._file.tell()
            if pos + len(s) > self._file.max_size:
                # Roll over to disk before writing
                await self.rollover()

        # Now delegate to executor (post-rollover) or directly (pre-rollover)
        rolled = await self._check()
        if rolled:
            loop = self._loop
            return await loop.run_in_executor(
                self._executor, self._file.write, s
            )
        else:
            return self._file.write(s)

    async def writelines(self, iterable):
        """Write lines, anticipating a possible rollover.

        Args:
            iterable: An iterable of strings or bytes to write.

        Returns:
            int: The total number of characters / bytes written.
        """
        import io

        # Calculate total size to anticipate rollover
        total_size = 0
        items = list(iterable)
        for item in items:
            total_size += len(item)

        # Check if we'll exceed max_size
        if self._file._file is None:
            pos = self._file.tell()
            if pos + total_size > self._file.max_size:
                await self.rollover()

        rolled = await self._check()
        if rolled:
            loop = self._loop
            return await loop.run_in_executor(
                self._executor, self._file.writelines, items
            )
        else:
            return self._file.writelines(items)


# ---------------------------------------------------------------------------
# AsyncTemporaryDirectory
# ---------------------------------------------------------------------------

@delegate_to_executor("cleanup")
@proxy_property_directly("name")
class AsyncTemporaryDirectory:
    """Async wrapper for ``tempfile.TemporaryDirectory``.

    Wraps a ``tempfile.TemporaryDirectory`` instance so that the blocking
    cleanup call is delegated to a thread-pool executor.
    """

    def __init__(self, file, loop=None, executor=None):
        self._file = file
        self._executor = executor
        self._ref_loop = loop

    @property
    def _loop(self):
        """Return the event loop, falling back to the running loop."""
        return self._ref_loop or asyncio.get_running_loop()

    async def close(self):
        """Close and clean up the temporary directory."""
        await self.cleanup()


# ---------------------------------------------------------------------------
# AiofilesContextManagerTempDir
# ---------------------------------------------------------------------------

class AiofilesContextManagerTempDir(AiofilesContextManager):
    """Async context manager for TemporaryDirectory.

    Unlike the regular ``AiofilesContextManager``, this class returns the
    *directory path string* (not the wrapper object) from ``__aenter__``,
    matching the behaviour of the synchronous ``tempfile.TemporaryDirectory``.
    """

    async def __aenter__(self):
        """Enter the context manager.

        Returns:
            str: The path of the created temporary directory.
        """
        self._obj = await self._coro
        return self._obj.name

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Exit the context manager, cleaning up the directory."""
        if self._obj is not None:
            await self._obj.close()
