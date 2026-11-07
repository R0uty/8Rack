from pathlib import Path

import pytest

from conftest import TOKEN
from rag_server.config import REPO_ROOT, ConfigError, load_settings


def test_reads_settings_and_fills_defaults(workspace: Path, tmp_path: Path):
    settings = load_settings({"RAG_MCP_TOKEN": TOKEN, "RAG_WORKSPACE_ROOT": str(workspace)}, env_file=tmp_path / "no.env")

    assert settings.workspace_root == workspace.resolve()
    assert settings.port == 8766
    assert settings.ollama_base_url == "http://127.0.0.1:11434"
    assert settings.embedding_model == "nomic-embed-text"
    assert (REPO_ROOT / "backend" / "data").resolve() in settings.excluded_dirs
    assert settings.index_file.parent in settings.excluded_dirs


def test_the_environment_wins_over_the_env_file(workspace: Path, tmp_path: Path):
    env_file = tmp_path / ".env"
    env_file.write_text(f"# comment\nRAG_MCP_TOKEN={TOKEN}\nRAG_WORKSPACE_ROOT={workspace}\nRAG_PORT=9000\n")

    assert load_settings({}, env_file=env_file).port == 9000
    assert load_settings({"RAG_PORT": "9100"}, env_file=env_file).port == 9100


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"RAG_MCP_TOKEN": ""}, "RAG_MCP_TOKEN must be at least 16 characters"),
        ({"RAG_MCP_TOKEN": "short"}, "RAG_MCP_TOKEN must be at least 16 characters"),
        ({"RAG_WORKSPACE_ROOT": ""}, "RAG_WORKSPACE_ROOT must be set"),
        ({"RAG_WORKSPACE_ROOT": "/no/such/folder"}, "RAG_WORKSPACE_ROOT is not a folder"),
        ({"RAG_PORT": "http"}, "RAG_PORT must be a number"),
        ({"RAG_PORT": "70000"}, "RAG_PORT must be between"),
    ],
)
def test_bad_settings_say_what_to_fix(workspace: Path, tmp_path: Path, overrides, message):
    environ = {"RAG_MCP_TOKEN": TOKEN, "RAG_WORKSPACE_ROOT": str(workspace), **overrides}
    with pytest.raises(ConfigError, match=message):
        load_settings(environ, env_file=tmp_path / "no.env")
