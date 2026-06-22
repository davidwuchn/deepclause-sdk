"""Configuration management for the ArXiv MCP Server."""

import sys
from pathlib import Path
from typing import Optional

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Server configuration settings."""

    APP_NAME: str = "arxiv-mcp-server"
    APP_VERSION: str = "0.2.11"
    MAX_RESULTS: int = 50
    BATCH_SIZE: int = 20
    REQUEST_TIMEOUT: int = 60
    HOST: str = "0.0.0.0"
    PORT: int = 8000

    def _get_storage_path_from_args(self) -> Optional[Path]:
        """Extract the storage path from command-line arguments."""
        args = sys.argv[1:]
        for i, arg in enumerate(args):
            if arg == "--storage-path" and i + 1 < len(args):
                return Path(args[i + 1])
        return None

    @property
    def STORAGE_PATH(self) -> Path:
        """Get and ensure the existence of the storage path."""
        path = (
            self._get_storage_path_from_args()
            or Path.home() / ".arxiv-mcp-server" / "papers"
        )
        path = path.resolve()
        path.mkdir(parents=True, exist_ok=True)
        return path


# Create a default settings instance
settings = Settings()
