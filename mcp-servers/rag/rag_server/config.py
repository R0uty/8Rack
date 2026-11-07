"""Settings, read once at startup from the environment and from mcp-servers/rag/.env.

A variable set in the environment wins over the same one in .env.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = SERVER_ROOT.parent.parent

# The server always listens here and nowhere else - see "Decided: the RAG server embeds through local
# Ollama" in DEVELOPMENT.md. Not a setting on purpose.
HOST = "127.0.0.1"

# A short token is guessable by anything else on this machine that can reach the port.
MIN_TOKEN_LENGTH = 16


class ConfigError(Exception):
    """A setting is missing or wrong. The message says which one and how to fix it."""


@dataclass(frozen=True)
class Settings:
    token: str
    workspace_root: Path
    index_file: Path
    port: int
    ollama_base_url: str
    embedding_model: str
    ollama_timeout_s: float
    # Never indexed, wherever the workspace points: this server's own index, and 8Rack's mission data,
    # which holds targets, scope and findings.
    excluded_dirs: tuple[Path, ...]


def read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        text = path.read_text("utf-8")
    except FileNotFoundError:
        return values
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def _resolve(raw: str) -> Path:
    path = Path(raw).expanduser()
    return (path if path.is_absolute() else SERVER_ROOT / path).resolve()


def load_settings(environ: Mapping[str, str] | None = None, env_file: Path = SERVER_ROOT / ".env") -> Settings:
    values = {**read_env_file(env_file), **(os.environ if environ is None else environ)}

    def get(name: str, default: str = "") -> str:
        return (values.get(name) or default).strip()

    token = get("RAG_MCP_TOKEN")
    if len(token) < MIN_TOKEN_LENGTH:
        raise ConfigError(
            f"RAG_MCP_TOKEN must be at least {MIN_TOKEN_LENGTH} characters. Use the same value as "
            "MCP_TOKEN_<ID> for this server in backend/.env."
        )

    workspace = get("RAG_WORKSPACE_ROOT")
    if not workspace:
        raise ConfigError("RAG_WORKSPACE_ROOT must be set to the folder to index, usually WORKSPACE_ROOT from backend/.env.")
    workspace_root = _resolve(workspace)
    if not workspace_root.is_dir():
        raise ConfigError(f"RAG_WORKSPACE_ROOT is not a folder: {workspace_root}")

    try:
        port = int(get("RAG_PORT", "8766"))
    except ValueError:
        raise ConfigError("RAG_PORT must be a number") from None
    if not 1 <= port <= 65535:
        raise ConfigError("RAG_PORT must be between 1 and 65535")

    try:
        ollama_timeout_s = float(get("OLLAMA_REQUEST_TIMEOUT_S", "60"))
    except ValueError:
        raise ConfigError("OLLAMA_REQUEST_TIMEOUT_S must be a number") from None

    index_file = _resolve(get("RAG_INDEX_FILE", "data/index.json"))
    return Settings(
        token=token,
        workspace_root=workspace_root,
        index_file=index_file,
        port=port,
        ollama_base_url=get("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/"),
        embedding_model=get("EMBEDDING_MODEL", "nomic-embed-text"),
        ollama_timeout_s=ollama_timeout_s,
        excluded_dirs=(index_file.parent, (REPO_ROOT / "backend" / "data").resolve()),
    )
