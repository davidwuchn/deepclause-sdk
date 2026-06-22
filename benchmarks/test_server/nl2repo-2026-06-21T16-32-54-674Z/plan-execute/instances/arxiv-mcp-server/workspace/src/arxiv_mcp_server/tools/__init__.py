"""Tools package for ArXiv MCP Server.

Provides unified imports for all tool modules:
    from arxiv_mcp_server.tools import (
        handle_search,
        handle_download,
        handle_list_papers,
        handle_read_paper,
        get_paper_path,
        conversion_statuses,
    )
"""

from arxiv_mcp_server.tools.search import handle_search
from arxiv_mcp_server.tools.download import (
    handle_download,
    get_paper_path,
    conversion_statuses,
)
from arxiv_mcp_server.tools.list_papers import handle_list_papers
from arxiv_mcp_server.tools.read_paper import handle_read_paper

__all__ = [
    "handle_search",
    "handle_download",
    "handle_list_papers",
    "handle_read_paper",
    "get_paper_path",
    "conversion_statuses",
]
