"""Prompt handlers for ArXiv MCP Server.

Exposes ``list_prompts()`` and ``get_prompt()`` that delegate to the
centralised :class:`PromptManager` singleton.
"""

from __future__ import annotations

from typing import Dict, List, Optional

from mcp.types import GetPromptResult, Prompt, PromptMessage, TextContent

from arxiv_mcp_server.prompts.prompt_manager import prompt_manager

# Ensure built-in prompts are registered before any handler is called.
from arxiv_mcp_server.prompts.prompts import register_builtin_prompts  # noqa: F401

__all__ = ["list_prompts", "get_prompt"]


async def list_prompts() -> List[Prompt]:
    """Return a list of all registered prompts."""
    return prompt_manager.list_prompts()


async def get_prompt(
    name: str,
    arguments: Dict[str, str] | None = None,
    session_id: Optional[str] = None,
) -> GetPromptResult:
    """Return a fully rendered prompt for *name* given *arguments*.

    Raises:
        ValueError: If the prompt is not found, if no arguments are
            provided, or if required arguments are missing.
    """
    # --- name validation ---
    if not prompt_manager.has_prompt(name):
        raise ValueError(f"Prompt not found: {name}")

    # --- arguments validation ---
    if arguments is None:
        raise ValueError("No arguments provided")

    if not arguments:
        raise ValueError("No arguments provided")

    required = prompt_manager.get_required_args(name)
    for arg in required:
        if arg not in arguments:
            raise ValueError(
                f"Missing required argument: {arg}",
            )

    # --- render ---
    rendered_text = prompt_manager.render(name, arguments)

    return GetPromptResult(
        description=prompt_manager.get_prompt_definition(name).description,
        messages=[
            PromptMessage(
                role="user",
                content=TextContent(type="text", text=rendered_text),
            )
        ],
    )
