"""MCP Server implementation for ArXiv MCP Server.

Provides standardized tool, prompt, and resource interfaces via the
Model Context Protocol (MCP), enabling seamless integration of AI
assistants with arXiv research functionality.
"""

from __future__ import annotations

from typing import Any, Dict, List

from mcp.server.lowlevel import Server
from mcp.types import Tool, TextContent

from arxiv_mcp_server.config import settings
from arxiv_mcp_server.prompts.handlers import (
    list_prompts as handler_list_prompts,
    get_prompt as handler_get_prompt,
)
from arxiv_mcp_server.resources.papers import (
    list_papers as resource_list_papers,
    read_paper_resource as resource_read_paper,
)
from arxiv_mcp_server.tools import (
    handle_search,
    handle_download,
    handle_list_papers,
    handle_read_paper,
)

# ---------------------------------------------------------------------------
# Tool definitions (JSON Schema)
# ---------------------------------------------------------------------------

search_tool = Tool(
    name="search_papers",
    description=(
        "Search for academic papers on arXiv by keywords, date ranges, "
        "and subject categories. Supports field specifiers (all:, ti:, "
        "abs:, au:, cat:) for precise queries."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Search query string. Supports field specifiers like ti:, abs:, au:, cat:.",
            },
            "max_results": {
                "type": "integer",
                "description": "Maximum number of results to return. Default: 10.",
                "default": 10,
            },
            "date_from": {
                "type": "string",
                "description": "Start date filter in ISO format (YYYY-MM-DD).",
            },
            "date_to": {
                "type": "string",
                "description": "End date filter in ISO format (YYYY-MM-DD).",
            },
            "categories": {
                "type": "array",
                "items": {"type": "string"},
                "description": "List of arXiv category filters, e.g. [\"cs.AI\", \"cs.LG\"].",
            },
        },
        "required": ["query"],
    },
)

download_tool = Tool(
    name="download_paper",
    description=(
        "Download an arXiv paper by its ID, automatically converting the "
        "PDF to Markdown format for easy reading. Supports status checking "
        "of ongoing or completed conversions."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "paper_id": {
                "type": "string",
                "description": "The arXiv paper ID to download (e.g. 2401.00123).",
            },
            "check_status": {
                "type": "boolean",
                "description": "If True, only check the download/conversion status without downloading. Default: false.",
                "default": False,
            },
        },
        "required": ["paper_id"],
    },
)

list_tool = Tool(
    name="list_papers",
    description=(
        "List all downloaded papers available in local storage, including "
        "paper metadata such as ID, title, file size, and resource URI."
    ),
    inputSchema={
        "type": "object",
        "properties": {},
    },
)

read_tool = Tool(
    name="read_paper",
    description=(
        "Read the full Markdown content of a downloaded paper by its arXiv ID."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "paper_id": {
                "type": "string",
                "description": "The arXiv paper ID to read (e.g. 2401.00123).",
            },
        },
        "required": ["paper_id"],
    },
)

TOOL_REGISTRY: Dict[str, Tool] = {
    "search_papers": search_tool,
    "download_paper": download_tool,
    "list_papers": list_tool,
    "read_paper": read_tool,
}

# ---------------------------------------------------------------------------
# Server instance
# ---------------------------------------------------------------------------

server = Server(
    name=settings.APP_NAME,
    version=settings.APP_VERSION,
    instructions=(
        "ArXiv MCP Server - Search, download, and analyze academic papers "
        "from arXiv. Use search_papers to find papers, download_paper to "
        "retrieve them, list_papers to see what's available, and read_paper "
        "to read full content."
    ),
)

# ---------------------------------------------------------------------------
# Tool handlers
# ---------------------------------------------------------------------------

@server.list_tools()
async def list_tools() -> List[Tool]:
    """List available arXiv research tools."""
    return list(TOOL_REGISTRY.values())


@server.call_tool()
async def call_tool(name: str, arguments: Dict[str, Any]) -> List[TextContent]:
    """Handle tool calls for arXiv research functionality."""
    try:
        if name == "search_papers":
            return await handle_search(arguments)
        elif name == "download_paper":
            return await handle_download(arguments)
        elif name == "list_papers":
            return await handle_list_papers(arguments)
        elif name == "read_paper":
            return await handle_read_paper(arguments)
        else:
            return [TextContent(type="text", text=f"Error: Unknown tool '{name}'")]
    except Exception as e:
        return [TextContent(type="text", text=f"Error: {str(e)}")]

# ---------------------------------------------------------------------------
# Prompt handlers
# ---------------------------------------------------------------------------

@server.list_prompts()
async def handle_list_prompts() -> List[Any]:
    """List available prompts."""
    return await handler_list_prompts()


@server.get_prompt()
async def handle_get_prompt(
    name: str,
    arguments: Dict[str, str] | None = None,
) -> Any:
    """Get a specific prompt with arguments."""
    return await handler_get_prompt(name, arguments)

# ---------------------------------------------------------------------------
# Resource handlers
# ---------------------------------------------------------------------------

@server.list_resources()
async def handle_list_resources() -> List[Any]:
    """List available paper resources."""
    return resource_list_papers()


@server.read_resource()
async def handle_read_resource(uri: Any) -> Any:
    """Read a paper resource by URI."""
    return await resource_read_paper(str(uri))
