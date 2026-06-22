"""ArXiv MCP Server - Academic paper search and analysis via Model Context Protocol."""

__version__ = "0.2.11"

from arxiv_mcp_server.config import Settings
from arxiv_mcp_server.prompts.handlers import list_prompts, get_prompt
from arxiv_mcp_server.resources.papers import (
    list_papers,
    read_paper_resource,
)
from arxiv_mcp_server.tools.download import (
    handle_download,
    get_paper_path,
    conversion_statuses,
)
from arxiv_mcp_server.tools import handle_search

__all__ = [
    "list_prompts",
    "get_prompt",
    "handle_download",
    "get_paper_path",
    "conversion_statuses",
    "handle_search",
    "Settings",
    "list_papers",
    "read_paper_resource",
]
