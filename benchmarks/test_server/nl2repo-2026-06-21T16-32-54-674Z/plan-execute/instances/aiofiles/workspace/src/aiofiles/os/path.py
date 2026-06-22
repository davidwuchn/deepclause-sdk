"""
Async versions of os.path functions.

All functions delegate blocking os.path operations to a thread pool executor
to avoid blocking the asyncio event loop.
"""

import os

from aiofiles.base import wrap

__all__ = [
    "abspath",
    "getatime",
    "getctime",
    "getmtime",
    "getsize",
    "exists",
    "isdir",
    "isfile",
    "islink",
    "ismount",
    "samefile",
    "sameopenfile",
]

# Async version of os.path.abspath
abspath = wrap(os.path.abspath)

# Async version of os.path.exists
exists = wrap(os.path.exists)

# Async version of os.path.isfile
isfile = wrap(os.path.isfile)

# Async version of os.path.isdir
isdir = wrap(os.path.isdir)

# Async version of os.path.islink
islink = wrap(os.path.islink)

# Async version of os.path.ismount
ismount = wrap(os.path.ismount)

# Async version of os.path.getsize
getsize = wrap(os.path.getsize)

# Async version of os.path.getatime
getatime = wrap(os.path.getatime)

# Async version of os.path.getctime
getctime = wrap(os.path.getctime)

# Async version of os.path.getmtime
getmtime = wrap(os.path.getmtime)

# Async version of os.path.samefile
samefile = wrap(os.path.samefile)

# Async version of os.path.sameopenfile
sameopenfile = wrap(os.path.sameopenfile)
