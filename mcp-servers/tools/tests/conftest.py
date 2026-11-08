from pathlib import Path

import pytest

from tools_server.catalog import CommandSpec
from tools_server.config import load_settings

TOKEN = "test-token-not-a-real-secret"

# A harmless catalog for tests - real recon binaries aren't installed in CI, so the tests drive
# commands that exist everywhere (echo, sleep) plus one deliberately-missing binary.
TEST_CATALOG = (
    CommandSpec(id="echo_test", description="echoes its arguments", executable="echo"),
    CommandSpec(id="sleep_test", description="sleeps", executable="sleep", timeout_s=0.3),
    CommandSpec(id="missing_test", description="a binary that isn't installed", executable="definitely-not-a-real-binary-xyz"),
)


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
        {"TOOLS_MCP_TOKEN": TOKEN, "TOOLS_WORKSPACE_ROOT": str(workspace)},
        env_file=tmp_path / "no.env",
    )
