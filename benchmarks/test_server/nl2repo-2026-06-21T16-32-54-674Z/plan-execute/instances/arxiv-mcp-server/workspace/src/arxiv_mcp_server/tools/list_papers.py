"""List papers tool for ArXiv MCP Server."""

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from mcp.types import TextContent as types_TextContent

from arxiv_mcp_server.config import settings


def list_papers() -> List[str]:
    """Scan local storage and return a list of paper IDs (stems of .md files)."""
    storage_path = Path(settings.STORAGE_PATH)
    if not storage_path.exists():
        return []
    return sorted([p.stem for p in storage_path.glob("*.md")])


def _extract_paper_metadata(md_path: Path) -> Dict[str, Any]:
    """Extract basic metadata from a Markdown paper file.

    Attempts to pull title from the first ``# heading`` line and returns
    whatever structural hints are available.
    """
    meta: Dict[str, Any] = {
        "id": md_path.stem,
        "file_path": str(md_path.resolve()),
        "resource_uri": f"file://{md_path.resolve()}",
        "size_bytes": md_path.stat().st_size,
    }

    try:
        text = md_path.read_text(encoding="utf-8")
        # Try to grab the title from the first heading line
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith("# "):
                meta["title"] = stripped[2:].strip()
                break
            elif stripped and not stripped.startswith("#"):
                # First non-empty, non-heading line as fallback
                meta["first_line"] = stripped[:120]
                break

        # Count approximate page-length
        meta["lines"] = text.count("\n") + 1
        meta["characters"] = len(text)
    except Exception:
        pass

    return meta


async def handle_list_papers(arguments: Optional[Dict[str, Any]] = None) -> List[types_TextContent]:
    """Handle requests to list all locally downloaded papers.

    Parameters
    ----------
    arguments : dict | None
        Currently unused; kept for MCP protocol compatibility.

    Returns
    -------
    List[types.TextContent]
        A single-element list whose ``text`` field is a JSON payload with
        ``total_papers``, ``storage_path``, and a ``papers`` array of
        per-paper metadata dicts.
    """
    paper_ids = list_papers()
    storage_path = Path(settings.STORAGE_PATH)

    papers: List[Dict[str, Any]] = []
    for pid in paper_ids:
        md_path = storage_path / f"{pid}.md"
        papers.append(_extract_paper_metadata(md_path))

    response = {
        "total_papers": len(papers),
        "storage_path": str(storage_path.resolve()),
        "papers": papers,
    }

    return [types_TextContent(type="text", text=json.dumps(response))]
