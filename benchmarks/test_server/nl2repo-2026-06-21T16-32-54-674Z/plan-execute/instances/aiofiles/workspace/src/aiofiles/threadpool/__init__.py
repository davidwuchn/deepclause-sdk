"""Asynchronous file operations using thread pool executor."""

import asyncio
import io
import sys
from functools import singledispatch
from typing import Any, Dict, Optional, Union

from aiofiles.base import AiofilesContextManager, wrap as _wrap_func
from aiofiles.threadpool.binary import (
    AsyncBufferedReader,
    AsyncFileIO,
    AsyncBufferedIOBase,
)
from aiofiles.threadpool.text import AsyncTextIOWrapper

__all__ = (
    "open",
    "stdin",
    "stdout",
    "stderr",
    "stdin_bytes",
    "stdout_bytes",
    "stderr_bytes",
)


# ---------------------------------------------------------------------------
# open() – async version of built-in open()
# ---------------------------------------------------------------------------

def open(
    file: str,
    mode: str = "r",
    buffering: int = -1,
    encoding: Optional[str] = None,
    errors: Optional[str] = None,
    newline: Optional[str] = None,
    closefd: bool = True,
    opener: Any = None,
    *,
    loop: Optional[asyncio.AbstractEventLoop] = None,
    executor: Optional[Any] = None,
) -> AiofilesContextManager:
    """Asynchronously open a file.

    Parameters
    ----------
    file : str
        Path to the file.
    mode : str, default "r"
        File open mode (same as built-in open).
    buffering : int, default -1
        Buffering hint (-1 = default, 0 = unbuffered, >0 = buffer size).
    encoding : str or None
        Text encoding (required for text mode).
    errors : str or None
        Error handling scheme for encoding errors.
    newline : str or None
        Newline handling.
    closefd : bool, default True
        Close the underlying file descriptor when the wrapper is closed.
    opener : any or None
        Custom opener function.
    loop : asyncio.AbstractEventLoop or None
        Event loop to use (None = current running loop).
    executor : any or None
        Executor to use (None = default ThreadPoolExecutor).

    Returns
    -------
    AiofilesContextManager
        An async context manager wrapping the opened file.
    """

    def _open_and_wrap():
        """Open the file and wrap it with async interface."""
        if opener is not None:
            fh = io.open(
                file,
                mode,
                buffering,
                encoding,
                errors,
                newline,
                closefd,
                opener,
            )
        else:
            fh = io.open(
                file,
                mode,
                buffering,
                encoding,
                errors,
                newline,
                closefd,
            )
        return wrap(fh, loop=loop, executor=executor)

    async def _coro():
        """Async coroutine that opens and wraps the file."""
        return _open_and_wrap()

    return AiofilesContextManager(_coro())


# ---------------------------------------------------------------------------
# wrap() – singledispatch wrapper for file-like objects
# ---------------------------------------------------------------------------

@singledispatch
def wrap(file: Any, *, loop: Any = None, executor: Any = None) -> Any:
    """Wrap a synchronous file-like object with an async interface.

    Parameters
    ----------
    file : Any
        The file-like object to wrap.
    loop : Any or None
        Event loop to use.
    executor : Any or None
        Executor to use.

    Returns
    -------
    Async file wrapper instance.

    Raises
    ------
    TypeError
        If the file type is not supported.
    """
    msg = f"Unsupported IO type: {file}"
    raise TypeError(msg)


@wrap.register(io.TextIOBase)
def _(file: io.TextIOBase, *, loop: Any = None, executor: Any = None) -> AsyncTextIOWrapper:
    return AsyncTextIOWrapper(file, loop=loop, executor=executor)


@wrap.register(io.BufferedWriter)
@wrap.register(io.BufferedIOBase)
def _(file: Union[io.BufferedWriter, io.BufferedIOBase], *, loop: Any = None, executor: Any = None) -> AsyncBufferedIOBase:
    return AsyncBufferedIOBase(file, loop=loop, executor=executor)


@wrap.register(io.BufferedReader)
@wrap.register(io.BufferedRandom)
def _(file: Union[io.BufferedReader, io.BufferedRandom], *, loop: Any = None, executor: Any = None) -> AsyncBufferedReader:
    return AsyncBufferedReader(file, loop=loop, executor=executor)


@wrap.register(io.FileIO)
def _(file: io.FileIO, *, loop: Any = None, executor: Any = None) -> AsyncFileIO:
    return AsyncFileIO(file, loop=loop, executor=executor)


# ---------------------------------------------------------------------------
# Standard I/O async wrappers
# ---------------------------------------------------------------------------

def _make_stdio(name: str, mode: str) -> Any:
    """Create an async stdio wrapper.

    Parameters
    ----------
    name : str
        Attribute name on sys (e.g. 'stdin', 'stdout', 'stderr').
    mode : str
        Open mode string passed to wrap (e.g. 'r' or 'w').

    Returns
    -------
    Wrapped stdio object with indirect file reference.
    """
    def _get():
        return getattr(sys, name)

    # Build the wrapper using the singledispatch wrap via the base wrap
    obj = wrap(_get(), loop=None, executor=None)  # type: ignore[arg-type]
    return obj


def _make_stdio_indirect(name: str) -> Any:
    """Create an indirect async stdio wrapper (re-opens each access).

    Parameters
    ----------
    name : str
        Attribute name on sys.

    Returns
    -------
    AsyncIndirect wrapper for the named stdio stream.
    """
    from aiofiles.threadpool.text import AsyncTextIndirectIOWrapper

    return AsyncTextIndirectIOWrapper(
        name=name,
        loop=None,
        executor=None,
        indirect=lambda: getattr(sys, name),
    )


# Text-mode standard streams
stdin = _make_stdio_indirect("stdin")
stdout = _make_stdio_indirect("stdout")
stderr = _make_stdio_indirect("stderr")

# Byte-mode standard streams – use binary wrapper types
def _make_stdio_bytes(name: str) -> Any:
    """Create an async byte-mode stdio wrapper.

    Parameters
    ----------
    name : str
        Attribute name on sys.

    Returns
    -------
    Async binary wrapper for the named stdio stream.
    """
    from aiofiles.threadpool.binary import AsyncIndirectBufferedIOBase

    return AsyncIndirectBufferedIOBase(
        name=name,
        loop=None,
        executor=None,
        indirect=lambda: getattr(sys, name).buffer,
    )


stdin_bytes = _make_stdio_bytes("stdin")
stdout_bytes = _make_stdio_bytes("stdout")
stderr_bytes = _make_stdio_bytes("stderr")
