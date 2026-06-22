"""Base classes and utilities for aiofiles asynchronous file operations."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from functools import wraps

from types import TracebackType
from typing import Any, Awaitable, Optional, Type


class AsyncBase:
    """Base class for all asynchronous file operations.
    
    Provides the basic functionality for all asynchronous file operations,
    including async iteration support.
    """

    def __init__(self, file: Any, loop: Optional[Any] = None, executor: Optional[Any] = None):
        self._file = file
        self._executor = executor
        self._ref_loop = loop

    @property
    def _loop(self) -> asyncio.AbstractEventLoop:
        """Get the event loop, using the stored reference or the currently running loop."""
        return self._ref_loop or asyncio.get_running_loop()

    def __aiter__(self):
        """We are our own iterator."""
        return self

    def __repr__(self) -> str:
        return super().__repr__() + " wrapping " + repr(self._file)

    async def __anext__(self) -> str:
        """Simulate normal file iteration.
        
        Returns:
            str: The next line of the file.
        
        Raises:
            StopAsyncIteration: If the end of the file is reached.
        """
        line = await self.readline()
        if line:
            return line
        raise StopAsyncIteration


class AsyncIndirectBase(AsyncBase):
    """Base class for all asynchronous indirect file operations.
    
    Used for file objects that may be replaced over time (e.g., SpooledTemporaryFile).
    The underlying file is obtained via an indirect callable.
    """

    def __init__(self, name: str, loop: Optional[Any] = None, executor: Optional[Any] = None, indirect: Optional[Any] = None):
        self._indirect = indirect
        self._name = name
        super().__init__(None, loop, executor)

    @property
    def _file(self) -> Any:
        """Get the current file object via the indirect callable."""
        return self._indirect()

    @_file.setter
    def _file(self, v: Any) -> None:
        """Discard writes to _file."""
        pass  # discard writes


class AiofilesContextManager:
    """An async context manager for aiofiles.
    
    Wraps a coroutine that returns a file-like object, allowing it to be
    used with async with statements.
    """

    __slots__ = ("_coro", "_obj")

    def __init__(self, coro: Awaitable):
        self._coro = coro
        self._obj: Optional[Any] = None

    def __await__(self):
        """Await the context manager.
        
        Returns:
            The object returned by the coroutine.
        """
        self._obj = yield from self._coro
        return self._obj

    async def __aenter__(self) -> Any:
        """Enter the context manager.
        
        Returns:
            The file-like object from the coroutine.
        """
        self._obj = await self._coro
        return self._obj

    async def __aexit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc_val: Optional[BaseException],
        exc_tb: Optional[TracebackType],
    ) -> None:
        """Exit the context manager.
        
        Args:
            exc_type: The type of the exception.
            exc_val: The value of the exception.
            exc_tb: The traceback of the exception.
        """
        if self._obj is not None:
            await self._obj.close()
            # Close the wrapper reference if present (for NamedTemporaryFile)
            wrapper = getattr(self._obj, "_wrapper_ref", None)
            if wrapper is not None:
                wrapper.close()


def wrap(func):
    """Wrap a synchronous function to run in a thread pool executor asynchronously.
    
    This decorator converts a blocking function into an async function by
    delegating its execution to a thread pool executor, preventing it from
    blocking the asyncio event loop.
    
    Args:
        func: The synchronous function to wrap.
    
    Returns:
        An async wrapper function that executes the original function in a thread pool.
    """
    @wraps(func)
    async def run(*args, loop=None, executor=None, **kwargs):
        """Wrap the function.
        
        Args:
            func: The function to wrap.
            args: The arguments to pass to the function.
            loop: The event loop to use.
            executor: The executor to use.
            kwargs: The keyword arguments to pass to the function.
        
        Returns:
            The result of the wrapped function call.
        """
        if loop is None:
            loop = asyncio.get_running_loop()
        
        if executor is None:
            executor = ThreadPoolExecutor()
        
        return await loop.run_in_executor(
            executor,
            lambda: func(*args, **kwargs),
        )
    return run
