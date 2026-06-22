"""Asynchronous wrappers for text file I/O operations.

Provides async versions of Python's text file types:
- AsyncTextIOWrapper          – wraps io.TextIOWrapper  (open(..., 'r'), open(..., 'w'))
- AsyncTextIndirectIOWrapper  – indirect version of AsyncTextIOWrapper

All blocking operations are delegated to a thread-pool executor so the
asyncio event loop is never blocked.
"""

from io import TextIOBase

from aiofiles.base import AsyncBase, AsyncIndirectBase
from aiofiles.threadpool.utils import (
    delegate_to_executor,
    proxy_method_directly,
    proxy_property_directly,
)


# ---------------------------------------------------------------------------
# AsyncTextIOWrapper
# ---------------------------------------------------------------------------

@delegate_to_executor(
    "close",
    "flush",
    "isatty",
    "read",
    "readable",
    "readline",
    "readlines",
    "seek",
    "seekable",
    "tell",
    "truncate",
    "write",
    "writable",
    "writelines",
)
@proxy_method_directly("detach", "fileno", "readable")
@proxy_property_directly(
    "buffer",
    "closed",
    "encoding",
    "errors",
    "line_buffering",
    "newlines",
    "name",
    "mode",
)
class AsyncTextIOWrapper(AsyncBase):
    """The asyncio executor version of io.TextIOWrapper."""


# ---------------------------------------------------------------------------
# AsyncTextIndirectIOWrapper
# ---------------------------------------------------------------------------

@delegate_to_executor(
    "close",
    "flush",
    "isatty",
    "read",
    "readable",
    "readline",
    "readlines",
    "seek",
    "seekable",
    "tell",
    "truncate",
    "write",
    "writable",
    "writelines",
)
@proxy_method_directly("detach", "fileno", "readable")
@proxy_property_directly(
    "buffer",
    "closed",
    "encoding",
    "errors",
    "line_buffering",
    "newlines",
    "name",
    "mode",
)
class AsyncTextIndirectIOWrapper(AsyncIndirectBase):
    """The indirect asyncio executor version of io.TextIOWrapper."""
