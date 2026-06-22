"""Utility functions and decorators for building async file wrappers.

Provides class decorators and helper functions used to construct the
various asynchronous file wrapper classes in aiofiles. These decorators
automatically wrap synchronous file operations so they execute in a
thread pool executor without blocking the asyncio event loop.
"""

import asyncio
from functools import wraps
from typing import Any, Callable


# ---------------------------------------------------------------------------
# Helper functions that generate methods / properties
# ---------------------------------------------------------------------------

def _make_delegate_method(attr_name: str) -> Callable:
    """Create an async method that delegates a call to the underlying file
    object via *self._loop.run_in_executor*.

    Args:
        attr_name: The name of the attribute (method) on the underlying
            file object to delegate to.

    Returns:
        An async method suitable for assignment to the wrapper class.
    """
    async def method(self, *args, **kwargs):
        loop = self._loop
        func = getattr(self._file, attr_name)
        return await loop.run_in_executor(self._executor, func, *args, **kwargs)

    method.__name__ = attr_name
    return method


def _make_proxy_method(attr_name: str) -> Callable:
    """Create a synchronous method that directly proxies a call to the
    underlying file object.

    Used for methods that return non-blocking information (e.g. *fileno*,
    *readable*) and should **not** be awaited.

    Args:
        attr_name: The name of the attribute (method) on the underlying
            file object to proxy.

    Returns:
        A synchronous method suitable for assignment to the wrapper class.
    """
    def method(self, *args, **kwargs):
        return getattr(self._file, attr_name)(*args, **kwargs)

    method.__name__ = attr_name
    return method


def _make_proxy_property(attr_name: str) -> property:
    """Create a property that reads an attribute directly from the
    underlying file object.

    Args:
        attr_name: The name of the attribute on the underlying file
            object to expose as a property.

    Returns:
        A ``property`` that returns the value of *attr_name* from the
        wrapped file.
    """
    def proxy_property(self):
        return getattr(self._file, attr_name)

    proxy_property.__name__ = attr_name
    return property(proxy_property)


def _make_cond_delegate_method(attr_name: str) -> Callable:
    """For spooled temporary files, delegate only if the file has been
    rolled over to a real on-disk file object.

    If the underlying ``SpooledTemporaryFile`` is still in-memory (i.e.
    ``_file._file`` is ``None``), the call is made directly on the
    spooled object.  Once rolled over, the call is dispatched through
    the executor to avoid blocking.

    Args:
        attr_name: The name of the attribute (method) to delegate.

    Returns:
        An async method suitable for assignment to the wrapper class.
    """
    async def method(self, *args, **kwargs):
        rolled = await self._check()
        if rolled:
            loop = self._loop
            func = getattr(self._file, attr_name)
            return await loop.run_in_executor(self._executor, func, *args, **kwargs)
        else:
            func = getattr(self._file, attr_name)
            return func(*args, **kwargs)

    method.__name__ = attr_name
    return method


# ---------------------------------------------------------------------------
# Class decorators
# ---------------------------------------------------------------------------

def delegate_to_executor(*attrs: str) -> Callable[[type], type]:
    """Class decorator that replaces synchronous methods on *attrs* with
    async versions that run in a thread-pool executor.

    For every *attr* in *attrs* the decorator creates an async method that
    calls ``self._loop.run_in_executor`` with the underlying
    ``self._file.<attr>`` callable.

    Args:
        attrs: Attribute names to delegate to the executor.

    Returns:
        The original class with the decorated methods attached.
    """
    def cls_builder(cls):
        for attr in attrs:
            setattr(cls, attr, _make_delegate_method(attr))
        return cls
    return cls_builder


def proxy_method_directly(*attrs: str) -> Callable[[type], type]:
    """Class decorator that creates thin synchronous wrapper methods for
    *attrs*.

    These methods call the corresponding method on ``self._file``
    **synchronously** – used for operations that are inherently fast or
    must return a synchronous value (e.g. file descriptor, mode flags).

    Args:
        attrs: Attribute names to proxy directly (synchronously).

    Returns:
        The original class with the proxied methods attached.
    """
    def cls_builder(cls):
        for attr in attrs:
            setattr(cls, attr, _make_proxy_method(attr))
        return cls
    return cls_builder


def proxy_property_directly(*attrs: str) -> Callable[[type], type]:
    """Class decorator that creates read-only properties for *attrs* that
    access the corresponding attribute on ``self._file`` directly.

    Args:
        attrs: Attribute names to expose as properties.

    Returns:
        The original class with the proxied properties attached.
    """
    def cls_builder(cls):
        for attr in attrs:
            setattr(cls, attr, _make_proxy_property(attr))
        return cls
    return cls_builder


def cond_delegate_to_executor(*attrs: str) -> Callable[[type], type]:
    """Class decorator that creates *conditional* async methods for *attrs*.

    Intended for ``SpooledTemporaryFile``-like wrappers: if the spooled
    file has already been rolled onto disk the call is delegated to the
    executor; otherwise it runs directly on the in-memory buffer.

    The class must provide an ``async def _check(self) -> bool`` method
    that returns ``True`` when the underlying file has been rolled over.

    Args:
        attrs: Attribute names to conditionally delegate.

    Returns:
        The original class with the conditionally-delegated methods
        attached.
    """
    def cls_builder(cls):
        for attr in attrs:
            setattr(cls, attr, _make_cond_delegate_method(attr))
        return cls
    return cls_builder
