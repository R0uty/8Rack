import pytest
from mcp.server.mcpserver.exceptions import ToolError

from conftest import TEST_CATALOG
from tools_server.runner import run_command

ECHO, SLEEP, MISSING = TEST_CATALOG


@pytest.mark.anyio
async def test_runs_a_command_and_returns_raw_output(settings):
    result = await run_command(ECHO, ["hello", "world"], settings)
    assert result["success"] is True
    assert result["exitCode"] == 0
    assert result["stdout"].strip() == "hello world"
    assert result["timedOut"] is False
    assert result["command"] == "echo hello world"


@pytest.mark.anyio
async def test_a_missing_binary_is_a_tool_error(settings):
    with pytest.raises(ToolError, match="is not installed"):
        await run_command(MISSING, [], settings)


@pytest.mark.anyio
async def test_a_path_argument_outside_the_workspace_is_refused(settings):
    with pytest.raises(ToolError, match="resolves outside the workspace root"):
        await run_command(ECHO, ["../../etc/passwd"], settings)


@pytest.mark.anyio
async def test_a_tilde_argument_is_refused(settings):
    with pytest.raises(ToolError, match='starts with "~"'):
        await run_command(ECHO, ["~/secrets"], settings)


@pytest.mark.anyio
async def test_non_string_arguments_are_refused(settings):
    with pytest.raises(ToolError, match="must be an array of strings"):
        await run_command(ECHO, [1, 2], settings)  # type: ignore[list-item]


@pytest.mark.anyio
async def test_a_slow_command_times_out_and_is_killed(settings):
    result = await run_command(SLEEP, ["5"], settings)  # timeout_s is 0.3
    assert result["timedOut"] is True
    assert result["success"] is False
    assert "timed out" in result["stderr"]
