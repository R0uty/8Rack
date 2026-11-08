from pathlib import Path

import pytest

from conftest import TOKEN
from tools_server.config import ConfigError, is_loopback, load_settings


def test_reads_settings_and_fills_defaults(workspace: Path, tmp_path: Path):
    settings = load_settings({"TOOLS_MCP_TOKEN": TOKEN, "TOOLS_WORKSPACE_ROOT": str(workspace)}, env_file=tmp_path / "no.env")

    assert settings.workspace_root == workspace.resolve()
    assert settings.bind_host == "127.0.0.1"
    assert settings.allowed_host == "127.0.0.1"
    assert settings.port == 8767
    assert settings.command_timeout_s == 300
    assert settings.max_output_bytes == 1_000_000
    assert settings.tls_certfile is None


def test_allowed_host_defaults_to_bind_host(workspace: Path, tmp_path: Path):
    settings = load_settings(
        {"TOOLS_MCP_TOKEN": TOKEN, "TOOLS_WORKSPACE_ROOT": str(workspace), "TOOLS_MCP_HOST": "127.0.0.1", "TOOLS_MCP_ALLOWED_HOST": "scan.local"},
        env_file=tmp_path / "no.env",
    )
    assert settings.bind_host == "127.0.0.1"
    assert settings.allowed_host == "scan.local"


def test_the_environment_wins_over_the_env_file(workspace: Path, tmp_path: Path):
    env_file = tmp_path / ".env"
    env_file.write_text(f"# comment\nTOOLS_MCP_TOKEN={TOKEN}\nTOOLS_WORKSPACE_ROOT={workspace}\nTOOLS_MCP_PORT=9000\n")

    assert load_settings({}, env_file=env_file).port == 9000
    assert load_settings({"TOOLS_MCP_PORT": "9100"}, env_file=env_file).port == 9100


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"TOOLS_MCP_TOKEN": ""}, "TOOLS_MCP_TOKEN must be at least 16 characters"),
        ({"TOOLS_MCP_TOKEN": "short"}, "TOOLS_MCP_TOKEN must be at least 16 characters"),
        ({"TOOLS_WORKSPACE_ROOT": ""}, "TOOLS_WORKSPACE_ROOT must be set"),
        ({"TOOLS_WORKSPACE_ROOT": "/no/such/folder"}, "TOOLS_WORKSPACE_ROOT is not a folder"),
        ({"TOOLS_MCP_PORT": "http"}, "TOOLS_MCP_PORT must be a number"),
        ({"TOOLS_MCP_PORT": "70000"}, "TOOLS_MCP_PORT must be between"),
        ({"TOOLS_COMMAND_TIMEOUT_S": "0"}, "TOOLS_COMMAND_TIMEOUT_S must be greater than 0"),
    ],
)
def test_bad_settings_say_what_to_fix(workspace: Path, tmp_path: Path, overrides, message):
    environ = {"TOOLS_MCP_TOKEN": TOKEN, "TOOLS_WORKSPACE_ROOT": str(workspace), **overrides}
    with pytest.raises(ConfigError, match=message):
        load_settings(environ, env_file=tmp_path / "no.env")


def test_a_non_loopback_bind_needs_https(workspace: Path, tmp_path: Path):
    base = {"TOOLS_MCP_TOKEN": TOKEN, "TOOLS_WORKSPACE_ROOT": str(workspace), "TOOLS_MCP_HOST": "0.0.0.0"}

    with pytest.raises(ConfigError, match="must be HTTPS"):
        load_settings(base, env_file=tmp_path / "no.env")

    # Behind a TLS proxy is an accepted way to serve HTTPS.
    assert load_settings({**base, "TOOLS_MCP_BEHIND_TLS_PROXY": "1"}, env_file=tmp_path / "no.env").bind_host == "0.0.0.0"


def test_tls_cert_and_key_must_come_as_a_pair(workspace: Path, tmp_path: Path):
    cert = tmp_path / "cert.pem"
    cert.write_text("x")
    environ = {"TOOLS_MCP_TOKEN": TOKEN, "TOOLS_WORKSPACE_ROOT": str(workspace), "TOOLS_MCP_TLS_CERTFILE": str(cert)}
    with pytest.raises(ConfigError, match="both TOOLS_MCP_TLS_CERTFILE and TOOLS_MCP_TLS_KEYFILE"):
        load_settings(environ, env_file=tmp_path / "no.env")


def test_tls_files_must_exist(workspace: Path, tmp_path: Path):
    environ = {
        "TOOLS_MCP_TOKEN": TOKEN,
        "TOOLS_WORKSPACE_ROOT": str(workspace),
        "TOOLS_MCP_TLS_CERTFILE": str(tmp_path / "missing-cert.pem"),
        "TOOLS_MCP_TLS_KEYFILE": str(tmp_path / "missing-key.pem"),
    }
    with pytest.raises(ConfigError, match="is not a file"):
        load_settings(environ, env_file=tmp_path / "no.env")


def test_is_loopback():
    assert is_loopback("127.0.0.1")
    assert is_loopback("localhost")
    assert is_loopback("::1")
    assert not is_loopback("0.0.0.0")
    assert not is_loopback("scan.example")
