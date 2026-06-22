"""Entry point for running the ArXiv MCP Server.

Usage:
    # As a module (default stdio transport):
        python -m arxiv_mcp_server

    # With custom storage path:
        python -m arxiv_mcp_server --storage-path /path/to/papers
"""

from __future__ import annotations

import argparse
import logging
import sys
import anyio

from mcp.server.stdio import stdio_server

from arxiv_mcp_server.config import Settings
from arxiv_mcp_server.server import server

logger = logging.getLogger("arxiv-mcp-server")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        prog="arxiv-mcp-server",
        description="ArXiv MCP Server - Academic paper search and analysis",
    )
    parser.add_argument(
        "--storage-path",
        type=str,
        default=None,
        help="Directory to store downloaded papers (default: ~/.arxiv-mcp-server/papers)",
    )
    parser.add_argument(
        "--host",
        type=str,
        default="0.0.0.0",
        help="Host to bind to for HTTP transport (default: 0.0.0.0)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="Port to bind to for HTTP transport (default: 8000)",
    )
    parser.add_argument(
        "--transport",
        type=str,
        choices=["stdio", "sse", "http"],
        default="stdio",
        help="Transport protocol to use (default: stdio)",
    )
    parser.add_argument(
        "--log-level",
        type=str,
        choices=["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
        default="INFO",
        help="Logging level (default: INFO)",
    )
    return parser.parse_args(argv)


def setup_logging(level: str = "INFO") -> None:
    """Configure logging for the server."""
    numeric_level = getattr(logging, level.upper(), logging.INFO)
    logging.basicConfig(
        level=numeric_level,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        handlers=[logging.StreamHandler(sys.stderr)],
    )


async def run_stdio_transport() -> None:
    """Run the MCP server with stdio transport."""
    logger.info("Starting ArXiv MCP Server with stdio transport")
    async with stdio_server() as (read_stream, write_stream):
        initialization_options = server.create_initialization_options()
        logger.debug("Initialization options: %s", initialization_options)
        await server.run(
            read_stream,
            write_stream,
            initialization_options,
            raise_exceptions=False,
        )
    logger.info("ArXiv MCP Server stopped")


def main(argv: list[str] | None = None) -> None:
    """Main entry point for the ArXiv MCP Server."""
    args = parse_args(argv)

    # Setup logging
    setup_logging(args.log_level)

    # Initialize settings (respects --storage-path from sys.argv)
    settings = Settings()

    logger.info("ArXiv MCP Server v%s", settings.APP_VERSION)
    logger.info("Storage path: %s", settings.STORAGE_PATH)

    try:
        anyio.run(run_stdio_transport)
    except KeyboardInterrupt:
        logger.info("Received keyboard interrupt, shutting down")
    except Exception as e:
        logger.error("Server error: %s", e, exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
