"""
Asynchronous temporary file operations.

Provides async wrappers for temporary file and directory operations
including TemporaryFile, NamedTemporaryFile, SpooledTemporaryFile,
and TemporaryDirectory.
"""

from functools import singledispatch
from io import (
    BufferedWriter,
    BufferedReader,
    BufferedRandom,
    FileIO,
    TextIOBase,
)

from aiofiles.base import AiofilesContextManager
from aiofiles.tempfile.temptypes import (
    AiofilesContextManagerTempDir,
    AsyncSpooledTemporaryFile,
    AsyncTemporaryDirectory,
)
from aiofiles.threadpool.binary import (
    AsyncBufferedIOBase,
    AsyncBufferedReader,
    AsyncFileIO,
)
from aiofiles.threadpool.text import AsyncTextIOWrapper

__all__ = [
    "NamedTemporaryFile",
    "TemporaryFile",
    "SpooledTemporaryFile",
    "TemporaryDirectory",
]


# ---------------------------------------------------------------------------
# Singledispatch wrap()
# ---------------------------------------------------------------------------

@singledispatch
def wrap(base_io_obj, file=None, *, loop=None, executor=None):
    """Wrap the object with interface based on type of underlying IO.

    Args:
        base_io_obj: The file object to wrap (dispatched on its type).
        file: Ignored; kept for backward compatibility with two-arg form.
        loop: The event loop to use (optional, defaults to running loop).
        executor: The executor to use (optional).

    Raises:
        TypeError: If the IO type is not supported.
    """
    msg = f"Unsupported IO type: {base_io_obj}"
    raise TypeError(msg)


@wrap.register(TextIOBase)
def _(base_io_obj, file=None, *, loop=None, executor=None):
    return AsyncTextIOWrapper(base_io_obj, loop=loop, executor=executor)


@wrap.register(BufferedWriter)
def _(base_io_obj, file=None, *, loop=None, executor=None):
    return AsyncBufferedIOBase(base_io_obj, loop=loop, executor=executor)


@wrap.register(BufferedReader)
def _(base_io_obj, file=None, *, loop=None, executor=None):
    return AsyncBufferedReader(base_io_obj, loop=loop, executor=executor)


@wrap.register(BufferedRandom)
def _(base_io_obj, file=None, *, loop=None, executor=None):
    return AsyncBufferedReader(base_io_obj, loop=loop, executor=executor)


@wrap.register(FileIO)
def _(base_io_obj, file=None, *, loop=None, executor=None):
    return AsyncFileIO(base_io_obj, loop=loop, executor=executor)


# ---------------------------------------------------------------------------
# Temporary file factory functions
# ---------------------------------------------------------------------------

def TemporaryFile(
    mode="w+b",
    buffering=-1,
    encoding=None,
    newline=None,
    suffix=None,
    prefix=None,
    dir=None,
    loop=None,
    executor=None,
):
    """Async open an unnamed temporary file.

    Args:
        mode: The mode to open the file (default "w+b").
        buffering: The buffering to use (default -1).
        encoding: The encoding to use (default None).
        newline: The newline handling (default None).
        suffix: The suffix for the temporary file.
        prefix: The prefix for the temporary file.
        dir: The directory in which to create the temporary file.
        loop: The event loop to use (optional).
        executor: The executor to use (optional).

    Returns:
        AiofilesContextManager: The context manager for the file.
    """
    import tempfile

    def _open_and_wrap():
        file = tempfile.TemporaryFile(
            mode=mode,
            buffering=buffering,
            encoding=encoding,
            newline=newline,
            suffix=suffix,
            prefix=prefix,
            dir=dir,
        )
        return wrap(file, loop=loop, executor=executor)

    async def _coro():
        return _open_and_wrap()

    return AiofilesContextManager(_coro())


def NamedTemporaryFile(
    mode="w+b",
    buffering=-1,
    encoding=None,
    newline=None,
    suffix=None,
    prefix=None,
    dir=None,
    delete=True,
    loop=None,
    executor=None,
):
    """Async open a named temporary file.

    Args:
        mode: The mode to open the file (default "w+b").
        buffering: The buffering to use (default -1).
        encoding: The encoding to use (default None).
        newline: The newline handling (default None).
        suffix: The suffix for the temporary file.
        prefix: The prefix for the temporary file.
        dir: The directory in which to create the temporary file.
        delete: Whether to delete the file on close (default True).
        loop: The event loop to use (optional).
        executor: The executor to use (optional).

    Returns:
        AiofilesContextManager: The context manager for the file.
    """
    import tempfile

    def _open_and_wrap():
        wrapper = tempfile.NamedTemporaryFile(
            mode=mode,
            buffering=buffering,
            encoding=encoding,
            newline=newline,
            suffix=suffix,
            prefix=prefix,
            dir=dir,
            delete=delete,
        )
        # _TemporaryFileWrapper has a .file attribute that is the actual IO object
        actual = wrapper.file
        async_file = wrap(actual, loop=loop, executor=executor)
        # Store the wrapper so __aexit__ can close it too
        async_file._wrapper_ref = wrapper
        return async_file

    async def _coro():
        return _open_and_wrap()

    return AiofilesContextManager(_coro())


def SpooledTemporaryFile(
    max_size=0,
    mode="w+b",
    buffering=-1,
    encoding=None,
    newline=None,
    suffix=None,
    prefix=None,
    dir=None,
    loop=None,
    executor=None,
):
    """Async open a spooled temporary file.

    Args:
        max_size: The maximum size before rolling over to disk (default 0).
        mode: The mode to open the file (default "w+b").
        buffering: The buffering to use (default -1).
        encoding: The encoding to use (default None).
        newline: The newline handling (default None).
        suffix: The suffix for the temporary file.
        prefix: The prefix for the temporary file.
        dir: The directory in which to create the temporary file.
        loop: The event loop to use (optional).
        executor: The executor to use (optional).

    Returns:
        AiofilesContextManager: The context manager for the file.
    """
    import tempfile

    def _open_and_wrap():
        file = tempfile.SpooledTemporaryFile(
            max_size=max_size,
            mode=mode,
            buffering=buffering,
            encoding=encoding,
            newline=newline,
            suffix=suffix,
            prefix=prefix,
            dir=dir,
        )
        return AsyncSpooledTemporaryFile(file, loop=loop, executor=executor)

    async def _coro():
        return _open_and_wrap()

    return AiofilesContextManager(_coro())


def TemporaryDirectory(
    suffix=None,
    prefix=None,
    dir=None,
    loop=None,
    executor=None,
):
    """Async open a temporary directory.

    Args:
        suffix: The suffix for the temporary directory name.
        prefix: The prefix for the temporary directory name.
        dir: The parent directory in which to create the temporary directory.
        loop: The event loop to use (optional).
        executor: The executor to use (optional).

    Returns:
        AiofilesContextManagerTempDir: The context manager for the temporary directory.
    """
    import tempfile

    def _open_and_wrap():
        dir_obj = tempfile.TemporaryDirectory(
            suffix=suffix,
            prefix=prefix,
            dir=dir,
        )
        return AsyncTemporaryDirectory(dir_obj, loop=loop, executor=executor)

    async def _coro():
        return _open_and_wrap()

    return AiofilesContextManagerTempDir(_coro())
