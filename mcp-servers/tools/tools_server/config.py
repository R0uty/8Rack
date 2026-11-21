"""Settings, read once at startup from the environment and from mcp-servers/tools/.env.

A variable set in the environment wins over the same one in .env. Mirrors the RAG server's config
conventions (mcp-servers/rag/rag_server/config.py); the differences are all about this server running
on a separate scanning host over HTTPS rather than loopback-only.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parent.parent

# A short token is guessable by anything else that can reach the port - and the server runs whatever an
# approved request names, so the token is the only thing between a stranger and a scan. See "Decided:
# HTTP to a separate scanning host" in DEVELOPMENT.md.
MIN_TOKEN_LENGTH = 16


class ConfigError(Exception):
    """A setting is missing or wrong. The message says which one and how to fix it."""


@dataclass(frozen=True)
class Settings:
    token: str
    # Where uvicorn binds. Defaults to loopback; set to the interface 8Rack reaches this host through.
    bind_host: str
    # The Host header the SDK's DNS-rebinding guard accepts - the name 8Rack connects by, which can
    # differ from bind_host when a TLS-terminating proxy sits in front.
    allowed_host: str
    port: int
    # The directory commands run in, and the root path-shaped arguments are confined to - the server
    # owns path containment for its own filesystem (see "What changes" in DEVELOPMENT.md).
    workspace_root: Path
    command_timeout_s: float
    max_output_bytes: int
    # Optional direct-HTTPS cert/key. When absent, a non-loopback bind must sit behind a TLS proxy.
    tls_certfile: Path | None
    tls_keyfile: Path | None


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


def is_loopback(host: str) -> bool:
    host = host.strip().lower().strip("[]")
    return host in {"localhost", "127.0.0.1", "::1"} or host.startswith("127.")


def load_settings(environ: Mapping[str, str] | None = None, env_file: Path = SERVER_ROOT / ".env") -> Settings:
    values = {**read_env_file(env_file), **(os.environ if environ is None else environ)}

    def get(name: str, default: str = "") -> str:
        return (values.get(name) or default).strip()

    token = get("TOOLS_MCP_TOKEN")
    if len(token) < MIN_TOKEN_LENGTH:
        raise ConfigError(
            f"TOOLS_MCP_TOKEN must be at least {MIN_TOKEN_LENGTH} characters. Use the same value as "
            "MCP_TOKEN_<ID> for this server in backend/.env."
        )

    workspace = get("TOOLS_WORKSPACE_ROOT")
    if not workspace:
        raise ConfigError("TOOLS_WORKSPACE_ROOT must be set to the folder tools run in (their cwd and path-containment root).")
    workspace_root = _resolve(workspace)
    if not workspace_root.is_dir():
        raise ConfigError(f"TOOLS_WORKSPACE_ROOT is not a folder: {workspace_root}")

    bind_host = get("TOOLS_MCP_HOST", "127.0.0.1")
    allowed_host = get("TOOLS_MCP_ALLOWED_HOST", bind_host)

    try:
        port = int(get("TOOLS_MCP_PORT", "8767"))
    except ValueError:
        raise ConfigError("TOOLS_MCP_PORT must be a number") from None
    if not 1 <= port <= 65535:
        raise ConfigError("TOOLS_MCP_PORT must be between 1 and 65535")

    try:
        command_timeout_s = float(get("TOOLS_COMMAND_TIMEOUT_S", "300"))
    except ValueError:
        raise ConfigError("TOOLS_COMMAND_TIMEOUT_S must be a number") from None
    if command_timeout_s <= 0:
        raise ConfigError("TOOLS_COMMAND_TIMEOUT_S must be greater than 0")

    try:
        max_output_bytes = int(get("TOOLS_MAX_OUTPUT_BYTES", "1000000"))
    except ValueError:
        raise ConfigError("TOOLS_MAX_OUTPUT_BYTES must be a number") from None
    if max_output_bytes < 1024:
        raise ConfigError("TOOLS_MAX_OUTPUT_BYTES must be at least 1024")

    certfile = get("TOOLS_MCP_TLS_CERTFILE")
    keyfile = get("TOOLS_MCP_TLS_KEYFILE")
    if bool(certfile) != bool(keyfile):
        raise ConfigError("Set both TOOLS_MCP_TLS_CERTFILE and TOOLS_MCP_TLS_KEYFILE, or neither.")
    tls_certfile = _resolve(certfile) if certfile else None
    tls_keyfile = _resolve(keyfile) if keyfile else None
    for label, p in (("TOOLS_MCP_TLS_CERTFILE", tls_certfile), ("TOOLS_MCP_TLS_KEYFILE", tls_keyfile)):
        if p is not None and not p.is_file():
            raise ConfigError(f"{label} is not a file: {p}")

    # 8Rack refuses plain http to anything but localhost, so a non-loopback bind has to serve HTTPS -
    # either directly (TLS cert/key here) or behind a TLS-terminating proxy the operator vouches for.
    behind_proxy = get("TOOLS_MCP_BEHIND_TLS_PROXY").lower() in {"1", "true", "yes"}
    if not is_loopback(bind_host) and tls_certfile is None and not behind_proxy:
        raise ConfigError(
            f"TOOLS_MCP_HOST={bind_host} is not loopback, so the connection must be HTTPS. Set "
            "TOOLS_MCP_TLS_CERTFILE/TOOLS_MCP_TLS_KEYFILE to serve TLS directly, or set "
            "TOOLS_MCP_BEHIND_TLS_PROXY=1 if a TLS-terminating proxy sits in front."
        )

    return Settings(
        token=token,
        bind_host=bind_host,
        allowed_host=allowed_host,
        port=port,
        workspace_root=workspace_root,
        command_timeout_s=command_timeout_s,
        max_output_bytes=max_output_bytes,
        tls_certfile=tls_certfile,
        tls_keyfile=tls_keyfile,
    )
