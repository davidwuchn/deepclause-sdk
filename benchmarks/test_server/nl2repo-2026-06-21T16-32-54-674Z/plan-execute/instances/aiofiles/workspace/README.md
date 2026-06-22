# aiofiles

Asynchronous file access for Python asyncio.

## Installation

```bash
pip install aiofiles
```

## Usage

```python
import aiofiles

async def read_file():
    async with aiofiles.open('test.txt', mode='r') as f:
        contents = await f.read()
        return contents
```
