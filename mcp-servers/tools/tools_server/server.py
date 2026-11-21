"""The MCP tools (one per catalog entry), and the HTTP app that serves them behind a bearer token.

The bearer-token middleware is identical to the RAG server's (mcp-servers/rag/rag_server/server.py) -
the same constant-time check, the same lifespan pass-through.
"""

from __future__ import annotations

import hmac
import json
from collections.abc import Awaitable, Callable

from mcp.server.mcpserver import MCPServer

from .catalog import CommandSpec, default_catalog, validate_catalog
from .config import Settings
from .runner import CommandResult, run_command


def _make_handler(spec: CommandSpec, settings: Settings) -> Callable[[list[str] | None], Awaitable[CommandResult]]:
    async def handler(args: list[str] | None = None) -> CommandResult:
        return await run_command(spec, args or [], settings)

    handler.__name__ = spec.id
    return handler


def create_server(settings: Settings, catalog: tuple[CommandSpec, ...] = ()) -> MCPServer:
    catalog = catalog or default_catalog()
    validate_catalog(catalog)
    server = MCPServer(name="8rack-tools", version="0.1.0")
    for spec in catalog:
        # args is the argv after the fixed "<executable> <default_args>" prefix - the server runs the
        # command and returns raw stdout/stderr/exit code; 8Rack already approved it and checked scope.
        server.tool(name=spec.id, description=spec.description)(_make_handler(spec, settings))
    return server


class BearerTokenMiddleware:
    """Rejects any HTTP request without the exact bearer token. Lifespan events pass straight through, so the
    MCP session manager still starts and stops."""

    def __init__(self, app, token: str) -> None:
        self._app = app
        self._expected = f"Bearer {token}".encode()

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] == "http":
            supplied = next((value for name, value in scope["headers"] if name == b"authorization"), b"")
            # Constant-time, so response timing doesn't reveal how much of a guess was right.
            if not hmac.compare_digest(supplied, self._expected):
                body = json.dumps({"error": "Missing or wrong bearer token"}).encode()
                await send(
                    {
                        "type": "http.response.start",
                        "status": 401,
                        "headers": [
                            (b"content-type", b"application/json"),
                            (b"www-authenticate", b"Bearer"),
                            (b"content-length", str(len(body)).encode()),
                        ],
                    }
                )
                await send({"type": "http.response.body", "body": body})
                return
        await self._app(scope, receive, send)


def create_app(settings: Settings, catalog: tuple[CommandSpec, ...] = ()):
    # Stateless, with plain JSON responses: 8Rack opens a connection per call and needs nothing held
    # between calls. Passing the allowed Host turns on the SDK's Host/Origin check (DNS-rebinding
    # defense), restricted to the name 8Rack connects by - 127.0.0.1 for a loopback bind, or a proxy's
    # public hostname (TOOLS_MCP_ALLOWED_HOST) when a TLS proxy fronts a loopback bind.
    app = create_server(settings, catalog).streamable_http_app(
        stateless_http=True,
        json_response=True,
        host=settings.allowed_host,
    )
    return BearerTokenMiddleware(app, settings.token)
