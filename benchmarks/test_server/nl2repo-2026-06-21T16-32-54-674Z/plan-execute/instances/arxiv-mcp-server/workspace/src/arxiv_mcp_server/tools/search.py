"""Search tool for ArXiv MCP Server."""

import json
from datetime import datetime
from typing import Any, Dict, List, Optional

import arxiv
from mcp.types import TextContent as types_TextContent

from arxiv_mcp_server.config import settings


# Field specifiers supported by arXiv
FIELD_SPECIFIERS = {"all:", "ti:", "abs:", "au:", "cat:", "co:", "r:", "j:", "rn:", "yr:", "id:", "or:"}


def _has_field_specifier(query: str) -> bool:
    """Check if the query already contains a field specifier."""
    for specifier in FIELD_SPECIFIERS:
        if query.startswith(specifier):
            return True
    return False


def _build_query(query: str, categories: Optional[List[str]] = None) -> str:
    """Build the arXiv search query with field specifiers and optional category filter.

    If the query does not already start with a field specifier, wrap it with `all:`
    so that arXiv searches across all fields, improving relevance.  If categories
    are provided, append a `cat:` filter for each category.
    """
    # If no field specifier is present, default to searching all fields
    if not _has_field_specifier(query):
        query = f"all:{query}"

    parts = [query]
    if categories:
        for cat in categories:
            parts.append(f"cat:{cat}")

    return " AND ".join(parts)


def _validate_date(date_str: str, field_name: str) -> str:
    """Validate and normalize a date string to 'YYYYMMDD' format expected by arxiv API.

    Raises ValueError with a descriptive message on invalid input.
    """
    for fmt in ("%Y-%m-%d", "%Y%m%d", "%Y/%m/%d"):
        try:
            return datetime.strptime(date_str, fmt).strftime("%Y%m%d")
        except ValueError:
            continue
    raise ValueError(
        f"Invalid date format for '{field_name}': '{date_str}'. "
        f"Use ISO format (YYYY-MM-DD)."
    )


def _format_paper(paper: arxiv.Result) -> Dict[str, Any]:
    """Convert an arxiv.Result into a plain dict for JSON serialization."""
    return {
        "id": paper.entry_id.split("/")[-1],
        "title": paper.title,
        "authors": paper.authors,
        "abstract": paper.summary,
        "categories": list(paper.categories),
        "published": paper.published.isoformat() if paper.published else None,
        "url": paper.pdf_url,
        "resource_uri": f"arxiv://{paper.entry_id.split('/')[-1]}",
    }


async def handle_search(arguments: Dict[str, Any]) -> List[types_TextContent]:
    """Handle paper search requests.

    Parameters
    ----------
    arguments : dict
        - query (str): The search query string.
        - max_results (int, optional): Maximum number of results (default: 10).
        - date_from (str, optional): Start date in ISO format (YYYY-MM-DD).
        - date_to (str, optional): End date in ISO format (YYYY-MM-DD).
        - categories (List[str], optional): Category filters (e.g. ["cs.AI", "cs.LG"]).

    Returns
    -------
    List[types.TextContent]
        A single-element list whose ``text`` field contains the JSON-serialised
        search results.
    """
    query: str = arguments.get("query", "")
    max_results: int = arguments.get("max_results", 10)
    date_from: Optional[str] = arguments.get("date_from")
    date_to: Optional[str] = arguments.get("date_to")
    categories: Optional[List[str]] = arguments.get("categories")

    # Clamp max_results to configured limit
    if max_results > settings.MAX_RESULTS:
        max_results = settings.MAX_RESULTS

    # --- Date validation ---------------------------------------------------
    if date_from:
        try:
            date_from = _validate_date(date_from, "date_from")
        except ValueError as exc:
            return [
                types_TextContent(
                    type="text",
                    text=f"Error: Invalid date format for date_from: {exc.args[0]}",
                )
            ]

    if date_to:
        try:
            date_to = _validate_date(date_to, "date_to")
        except ValueError as exc:
            return [
                types_TextContent(
                    type="text",
                    text=f"Error: Invalid date format for date_to: {exc.args[0]}",
                )
            ]

    # --- Build the search query --------------------------------------------
    search_query = _build_query(query, categories)

    # --- Execute the arXiv search ------------------------------------------
    try:
        search = arxiv.Search(
            query=search_query,
            max_results=max_results,
            sort_by=arxiv.SortCriterion.Relevance,
            sort_order=arxiv.SortOrder.Descending,
        )

        client = arxiv.Client(page_size=settings.BATCH_SIZE)
        results = list(client.results(search))
    except Exception as exc:
        return [
            types_TextContent(
                type="text",
                text=json.dumps({"error": f"Search failed: {str(exc)}"}),
            )
        ]

    # --- Format results ----------------------------------------------------
    papers = [_format_paper(p) for p in results]

    response = {
        "total_results": len(papers),
        "query": query,
        "papers": papers,
    }

    return [types_TextContent(type="text", text=json.dumps(response))]
