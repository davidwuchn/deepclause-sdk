"""Prompt definitions for ArXiv MCP Server.

Registers built-in prompts with the :data:`prompt_manager` singleton so they
are available to the MCP server's prompt interface.
"""

from __future__ import annotations

from typing import Dict

from mcp.types import PromptArgument

from arxiv_mcp_server.prompts.deep_research_analysis_prompt import (
    PAPER_ANALYSIS_PROMPT,
)
from arxiv_mcp_server.prompts.prompt_manager import prompt_manager

__all__ = ["register_builtin_prompts"]


def _render_deep_paper_analysis(arguments: Dict[str, str]) -> str:
    """Render the deep paper analysis prompt, inserting the paper_id."""
    paper_id = arguments.get("paper_id", "UNKNOWN")
    return f"Analyze the following paper: {paper_id}\n\n{PAPER_ANALYSIS_PROMPT}"


DEEP_PAPER_ANALYSIS_ARGUMENTS: list[PromptArgument] = [
    PromptArgument(
        name="paper_id",
        description="The arXiv paper ID to analyze (e.g. 2401.00123).",
        required=True,
    ),
]


def register_builtin_prompts() -> None:
    """Register all built-in prompts with the prompt manager."""
    prompt_manager.register(
        name="deep-paper-analysis",
        description=(
            "Comprehensive analysis of an academic paper from arXiv. "
            "Provides a structured workflow for evaluating research quality, "
            "methodology, results, and broader implications."
        ),
        arguments=DEEP_PAPER_ANALYSIS_ARGUMENTS,
        render=_render_deep_paper_analysis,
        required_args=["paper_id"],
    )


# Auto-register on import so that the singleton is always ready.
register_builtin_prompts()
