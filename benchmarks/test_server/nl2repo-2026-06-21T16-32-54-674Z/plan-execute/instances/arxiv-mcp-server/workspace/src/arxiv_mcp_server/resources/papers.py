"""Papers resource module for ArXiv MCP Server.

Provides paper resources through the MCP protocol, enabling AI assistants
to list and read downloaded academic papers as structured resources.
"""

from pathlib import Path
from typing import Iterable, List

from mcp.server.lowlevel.helper_types import ReadResourceContents
from mcp.types import (
    Resource,
    TextResourceContents,
)

from arxiv_mcp_server.config import settings


def _storage_path() -> Path:
    """Return the resolved storage path for downloaded papers."""
    return Path(settings.STORAGE_PATH).resolve()


def list_papers() -> List[Resource]:
    """List all locally available paper resources.

    Scans the storage directory for ``.md`` files and returns a list of
    :class:`mcp.types.Resource` objects, one per found paper.

    Returns
    -------
    list[Resource]
        A list of MCP Resource objects describing each downloaded paper.
    """
    papers_dir = _storage_path()
    resources: List[Resource] = []

    if not papers_dir.exists():
        return resources

    for md_path in sorted(papers_dir.glob("*.md")):
        paper_id = md_path.stem
        resource_uri = f"arxiv://{paper_id}"

        # Try to extract a title from the first line (Markdown heading)
        title = paper_id
        try:
            first_line = md_path.read_text(encoding="utf-8").splitlines()[0]
            if first_line.startswith("# "):
                title = first_line.lstrip("# ").strip()
            elif first_line.strip():
                title = first_line.strip()
        except (IndexError, OSError):
            pass

        resources.append(
            Resource(
                uri=resource_uri,
                name=paper_id,
                title=title,
                description=f"Downloaded arXiv paper: {paper_id}",
                mimeType="text/markdown",
            )
        )

    return resources


async def read_paper_resource(uri: str) -> Iterable[ReadResourceContents]:
    """Read the content of a single paper resource.

    Parameters
    ----------
    uri : str
        The resource URI in the form ``arxiv://<paper_id>``.

    Returns
    -------
    Iterable[ReadResourceContents]
        An iterable containing exactly one :class:`ReadResourceContents`
        with the Markdown text of the paper.

    Raises
    ------
    ValueError
        If the URI scheme is not ``arxiv://``.
    FileNotFoundError
        If the requested paper file does not exist in local storage.
    """
    # Parse the URI
    if not uri.startswith("arxiv://"):
        raise ValueError(f"Unsupported resource URI scheme: {uri}")

    paper_id = uri[len("arxiv://") :]
    if not paper_id:
        raise ValueError("Empty paper_id in resource URI")

    md_path = _storage_path() / f"{paper_id}.md"

    if not md_path.exists():
        raise FileNotFoundError(
            f"Paper '{paper_id}' not found in local storage at {md_path}"
        )

    content = md_path.read_text(encoding="utf-8")

    return [
        ReadResourceContents(
            content=content,
            mime_type="text/markdown",
        )
    ]
