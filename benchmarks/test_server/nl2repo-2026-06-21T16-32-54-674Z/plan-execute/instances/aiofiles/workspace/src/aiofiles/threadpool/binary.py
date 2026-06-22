"""Asynchronous wrappers for binary file I/O operations.

Provides async versions of Python's binary file types:
- AsyncBufferedIOBase  – wraps io.BufferedIOBase (e.g. open(..., 'rb'), open(..., 'wb'))
- AsyncBufferedReader  – wraps io.BufferedReader / io.BufferedRandom (adds peek)
- AsyncFileIO          – wraps io.FileIO  (buffering=0, raw I/O)
- AsyncIndirectBufferedIOBase  – indirect version of AsyncBufferedIOBase
- AsyncIndirectBufferedReader  – indirect version of AsyncBufferedReader
- AsyncIndirectFileIO          – indirect version of AsyncFileIO

All blocking operations are delegated to a thread-pool executor so the
asyncio event loop is never blocked.
"""

from io import BufferedIOBase, BufferedReader, BufferedRandom, BufferedWriter, FileIO

from aiofiles.base import AsyncBase, AsyncIndirectBase
from aiofiles.threadpool.utils import (
    cond_delegate_to_executor,
    delegate_to_executor,
    proxy_method_directly,
    proxy_property_directly,
)


# ---------------------------------------------------------------------------
# AsyncBufferedIOBase
# ---------------------------------------------------------------------------

@delegate_to_executor(
    "close",
    "flush",
    "isatty",
    "read",
    "read1",
    "readinto",
    "readline",
    "readlines",
    "seek",
    "seekable",
    "tell",
    "truncate",
    "writable",
    "write",
    "writelines",
)
@proxy_method_directly("detach", "fileno", "readable")
@proxy_property_directly("closed", "raw", "name", "mode")
class AsyncBufferedIOBase(AsyncBase):
    """The asyncio executor version of io.BufferedIOBase."""


# ---------------------------------------------------------------------------
# AsyncBufferedReader
# ---------------------------------------------------------------------------

@delegate_to_executor("peek")
class AsyncBufferedReader(AsyncBufferedIOBase):
    """The asyncio executor version of io.BufferedReader and BufferedRandom."""


# ---------------------------------------------------------------------------
# AsyncFileIO
# ---------------------------------------------------------------------------

@delegate_to_executor(
    "close",
    "flush",
    "isatty",
    "read",
    "readall",
    "readinto",
    "readline",
    "readlines",
    "seek",
    "seekable",
    "tell",
    "truncate",
    "writable",
    "write",
    "writelines",
)
@proxy_method_directly("fileno", "readable")
@proxy_property_directly("closed", "name", "mode")
class AsyncFileIO(AsyncBase):
    """The asyncio executor version of io.FileIO."""


# ---------------------------------------------------------------------------
# AsyncIndirectBufferedIOBase
# ---------------------------------------------------------------------------

@delegate_to_executor(
    "close",
    "flush",
    "isatty",
    "read",
    "read1",
    "readinto",
    "readline",
    "readlines",
    "seek",
    "seekable",
    "tell",
    "truncate",
    "writable",
    "write",
    "writelines",
)
@proxy_method_directly("detach", "fileno", "readable")
@proxy_property_directly("closed", "raw", "name", "mode")
class AsyncIndirectBufferedIOBase(AsyncIndirectBase):
    """The indirect asyncio executor version of io.BufferedIOBase."""


# ---------------------------------------------------------------------------
# AsyncIndirectBufferedReader
# ---------------------------------------------------------------------------

@delegate_to_executor("peek")
class AsyncIndirectBufferedReader(AsyncIndirectBufferedIOBase):
    """The indirect asyncio executor version of io.BufferedReader and BufferedRandom."""


# ---------------------------------------------------------------------------
# AsyncIndirectFileIO
# ---------------------------------------------------------------------------

@delegate_to_executor(
    "close",
    "flush",
    "isatty",
    "read",
    "readall",
    "readinto",
    "readline",
    "readlines",
    "seek",
    "seekable",
    "tell",
    "truncate",
    "writable",
    "write",
    "writelines",
)
@proxy_method_directly("fileno", "readable")
@proxy_property_directly("closed", "name", "mode")
class AsyncIndirectFileIO(AsyncIndirectBase):
    """The indirect asyncio executor version of io.FileIO."""
