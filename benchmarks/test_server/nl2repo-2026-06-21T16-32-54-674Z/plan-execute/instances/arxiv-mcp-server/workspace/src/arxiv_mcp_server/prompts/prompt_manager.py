"""Prompt manager for ArXiv MCP Server.

Registers and retrieves available prompts by name, providing a centralized
prompt registry for the MCP server.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from mcp.types import Prompt, PromptArgument

__all__ = ["PromptManager", "prompt_manager"]


class PromptManager:
    """Manages registration and retrieval of available prompts.

    Each registered prompt has a name, description, optional argument
    definitions, and a render function that produces the prompt text
    from supplied arguments.
    """

    def __init__(self) -> None:
        self._prompts: Dict[str, Prompt] = {}
        self._renderers: Dict[str, Callable[[Dict[str, str]], str]] = {}
        self._required_args: Dict[str, List[str]] = {}

    # ------------------------------------------------------------------
    # Registration
    # ------------------------------------------------------------------

    def register(
        self,
        name: str,
        *,
        description: str,
        arguments: Optional[List[PromptArgument]] = None,
        render: Callable[[Dict[str, str]], str],
        required_args: Optional[List[str]] = None,
    ) -> None:
        """Register a prompt with the manager.

        Args:
            name: Unique prompt identifier (e.g. ``"deep-paper-analysis"``).
            description: Human-readable description of the prompt.
            arguments: Optional list of :class:`mcp.types.PromptArgument`
                objects that describe expected input parameters.
            render: Callable that takes a dict of string arguments and
                returns the fully rendered prompt text.
            required_args: Optional list of argument names that must be
                present when the prompt is retrieved.
        """
        self._prompts[name] = Prompt(
            name=name,
            description=description,
            arguments=arguments if arguments is not None else [],
        )
        self._renderers[name] = render
        self._required_args[name] = required_args or []

    # ------------------------------------------------------------------
    # Retrieval
    # ------------------------------------------------------------------

    def list_prompts(self) -> List[Prompt]:
        """Return all registered :class:`mcp.types.Prompt` objects."""
        return list(self._prompts.values())

    def get_prompt_definition(self, name: str) -> Optional[Prompt]:
        """Return the registered prompt definition, or ``None`` if not found."""
        return self._prompts.get(name)

    def get_required_args(self, name: str) -> List[str]:
        """Return the list of required argument names for *name*."""
        return self._required_args.get(name, [])

    def render(self, name: str, arguments: Dict[str, str]) -> str:
        """Render a registered prompt with the supplied *arguments*.

        Raises:
            ValueError: If the prompt is not registered.
        """
        render_fn = self._renderers.get(name)
        if render_fn is None:
            raise ValueError(f"Prompt not found: {name}")
        return render_fn(arguments)

    # ------------------------------------------------------------------
    # Convenience
    # ------------------------------------------------------------------

    def has_prompt(self, name: str) -> bool:
        """Return ``True`` if *name* is registered."""
        return name in self._prompts

    @property
    def prompt_names(self) -> List[str]:
        """Return sorted list of registered prompt names."""
        return sorted(self._prompts.keys())


# ---------------------------------------------------------------------------
# Module-level singleton – import once and use everywhere
# ---------------------------------------------------------------------------

prompt_manager = PromptManager()
