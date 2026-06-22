"""Read paper tool for ArXiv MCP Server."""

import json
from pathlib import Path
from typing import Any, Dict, List

from mcp.types import TextContent as types_TextContent

from arxiv_mcp_server.tools.download import get_paper_path


async def handle_read_paper(arguments: Dict[str, Any]) -> List[types_TextContent]:
    """Read and return Markdown-formatted content of a downloaded paper.

    Parameters
    ----------
    arguments : dict
        Must contain ``paper_id`` (str).

    Returns
    -------
    list[types.TextContent]
        A single-element list whose text is the Markdown content (or a JSON
        error payload when the paper is not available).
    """
    paper_id: str = arguments["paper_id"]
    md_path: Path = get_paper_path(paper_id, ".md")

    if not md_path.exists():
        return [
            types_TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "error",
                        "message": f"Paper {paper_id} not found in local storage. "
                                   "Download it first with the download_paper tool.",
                    }
                ),
            )
        ]

    try:
        content = md_path.read_text(encoding="utf-8")
    except OSError as exc:
        return [
            types_TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "error",
                        "message": f"Failed to read paper: {exc}",
                    }
                ),
            )
        ]

    return [
        types_TextContent(
            type="text",
            text=json.dumps(
                {
                    "paper_id": paper_id,
                    "resource_uri": f"file://{md_path.resolve()}",
                    "content": content,
                }
            ),
        )
    ]
