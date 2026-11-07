from pathlib import Path

import pytest

from rag_server.config import load_settings

TOKEN = "test-token-not-a-real-secret"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    root = tmp_path / "workspace"
    root.mkdir()
    return root


@pytest.fixture
def settings(tmp_path: Path, workspace: Path):
    return load_settings(
        {"RAG_MCP_TOKEN": TOKEN, "RAG_WORKSPACE_ROOT": str(workspace), "RAG_INDEX_FILE": str(tmp_path / "index" / "index.json")},
        env_file=tmp_path / "no.env",
    )


async def keyword_embed(texts: list[str]) -> list[list[float]]:
    """A stand-in for Ollama: one dimension per keyword, so ranking is predictable."""
    return [[t.count("apple"), t.count("banana"), 0.1] for t in texts]
