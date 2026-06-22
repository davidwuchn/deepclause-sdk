"""Paper download tool for ArXiv MCP Server."""

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from mcp.types import TextContent as types_TextContent

from arxiv_mcp_server.config import Settings

settings = Settings()


@dataclass
class ConversionStatus:
    """Track the status of a PDF-to-Markdown conversion for a single paper."""

    paper_id: str
    status: str  # 'downloading', 'converting', 'success', 'error', 'unknown'
    started_at: datetime
    completed_at: Optional[datetime] = None
    error: Optional[str] = None


# Global registry: paper_id -> ConversionStatus
conversion_statuses: Dict[str, ConversionStatus] = {}


def get_paper_path(paper_id: str, suffix: str = ".md") -> Path:
    """Return the full filesystem path for *paper_id* with the given *suffix*.

    Creates the storage directory if it does not yet exist.
    """
    storage_path = Path(settings.STORAGE_PATH)
    storage_path.mkdir(parents=True, exist_ok=True)
    return storage_path / f"{paper_id}{suffix}"


async def handle_download(arguments: Dict[str, Any]) -> List[types_TextContent]:
    """Handle paper download and conversion requests.

    Parameters
    ----------
    arguments : dict
        Must contain ``paper_id`` (str).  Optional keys:
        * ``check_status`` (bool) – if True, only report current status.

    Returns
    -------
    list[types.TextContent]
        A single-element list with a JSON payload describing the status.
    """
    import asyncio
    import json

    import arxiv

    paper_id: str = arguments["paper_id"]
    check_status: bool = arguments.get("check_status", False)

    # --- Status-only check ---------------------------------------------------
    if check_status:
        md_path = get_paper_path(paper_id, ".md")
        pdf_path = get_paper_path(paper_id, ".pdf")

        if paper_id in conversion_statuses:
            cs = conversion_statuses[paper_id]
            payload = {
                "status": cs.status,
                "started_at": cs.started_at.isoformat(),
                "completed_at": cs.completed_at.isoformat() if cs.completed_at else None,
                "error": cs.error,
                "message": f"Paper conversion {cs.status}",
            }
        elif md_path.exists():
            payload = {
                "status": "success",
                "message": "Paper is ready",
                "resource_uri": f"file://{md_path.resolve()}",
            }
        else:
            payload = {
                "status": "unknown",
                "message": "No download or conversion in progress",
            }
        return [types_TextContent(type="text", text=json.dumps(payload))]

    # --- Check if already available ------------------------------------------
    md_path = get_paper_path(paper_id, ".md")
    if md_path.exists():
        payload = {
            "status": "success",
            "message": "Paper already available",
            "resource_uri": f"file://{md_path.resolve()}",
        }
        return [types_TextContent(type="text", text=json.dumps(payload))]

    # --- Download PDF --------------------------------------------------------
    try:
        client = arxiv.Client(page_size=settings.BATCH_SIZE)
        paper = next(client.results(arxiv.Search(id_list=[paper_id])))
    except StopIteration:
        return [
            types_TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "error",
                        "message": f"Paper {paper_id} not found on arXiv",
                    }
                ),
            )
        ]
    except Exception as exc:
        return [
            types_TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "error",
                        "message": f"Failed to fetch paper metadata: {exc}",
                    }
                ),
            )
        ]

    conversion_statuses[paper_id] = ConversionStatus(
        paper_id=paper_id,
        status="downloading",
        started_at=datetime.now(),
    )

    pdf_path = get_paper_path(paper_id, ".pdf")
    try:
        await asyncio.get_event_loop().run_in_executor(
            None, _download_pdf_sync, paper, pdf_path
        )
    except Exception as exc:
        conversion_statuses[paper_id] = ConversionStatus(
            paper_id=paper_id,
            status="error",
            started_at=datetime.now(),
            error=str(exc),
        )
        return [
            types_TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "error",
                        "message": f"Download failed: {exc}",
                    }
                ),
            )
        ]

    # --- Convert PDF -> Markdown ---------------------------------------------
    conversion_statuses[paper_id] = ConversionStatus(
        paper_id=paper_id,
        status="converting",
        started_at=conversion_statuses[paper_id].started_at,
    )

    try:
        await asyncio.get_event_loop().run_in_executor(
            None, _convert_pdf_to_md_sync, pdf_path, md_path
        )
    except Exception as exc:
        conversion_statuses[paper_id] = ConversionStatus(
            paper_id=paper_id,
            status="error",
            started_at=conversion_statuses[paper_id].started_at,
            completed_at=datetime.now(),
            error=str(exc),
        )
        return [
            types_TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "error",
                        "message": f"Conversion failed: {exc}",
                    }
                ),
            )
        ]

    conversion_statuses[paper_id] = ConversionStatus(
        paper_id=paper_id,
        status="success",
        started_at=conversion_statuses[paper_id].started_at,
        completed_at=datetime.now(),
    )

    payload = {
        "status": "success",
        "message": "Paper downloaded and converted successfully",
        "started_at": conversion_statuses[paper_id].started_at.isoformat(),
        "completed_at": conversion_statuses[paper_id].completed_at.isoformat(),
        "resource_uri": f"file://{md_path.resolve()}",
    }
    return [types_TextContent(type="text", text=json.dumps(payload))]


# ------------------------------------------------------------------ helpers


def _download_pdf_sync(paper, pdf_path: Path) -> None:
    """Synchronous helper: download a paper's PDF to *pdf_path*."""
    import urllib.request

    pdf_url = paper.pdf_url
    urllib.request.urlretrieve(pdf_url, str(pdf_path))


def _convert_pdf_to_md_sync(pdf_path: Path, md_path: Path) -> None:
    """Synchronous helper: convert *pdf_path* to Markdown at *md_path*."""
    import pymupdf4llm

    md_text = pymupdf4llm.to_markdown(str(pdf_path))
    md_path.write_text(md_text, encoding="utf-8")
