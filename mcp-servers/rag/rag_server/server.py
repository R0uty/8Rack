"""The MCP tools, and the HTTP app that serves them behind a bearer token."""

from __future__ import annotations

import hmac
import json
from typing import TypedDict

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

from .config import HOST, Settings
from .index import Index, ReindexInProgressError, ReindexTimeoutError
from .ollama import EmbeddingError

MAX_QUERY_CHARS = 2000
MAX_TOP_K = 20


class Status(TypedDict):
    indexedAt: int | None
    fileCount: int
    chunkCount: int
    embeddingModel: str
    workspaceRoot: str


class SearchResult(TypedDict):
    filePath: str
    startLine: int
    endLine: int
    text: str
    score: float


class SearchResults(TypedDict):
    results: list[SearchResult]


def create_server(index: Index) -> MCPServer:
    server = MCPServer(name="8rack-rag", version="0.1.0")

    @server.tool(description="Semantic search over the indexed workspace. Returns the closest chunks, best first.")
    async def search(query: str, top_k: int = 5) -> SearchResults:
        query = query.strip()
        if not query:
            raise ToolError("query must not be empty")
        if len(query) > MAX_QUERY_CHARS:
            raise ToolError(f"query must be at most {MAX_QUERY_CHARS} characters")
        try:
            results = await index.search(query, max(1, min(top_k, MAX_TOP_K)))
        except EmbeddingError as err:
            raise ToolError(str(err)) from None
        return {"results": results}

    @server.tool(description="Rebuild the whole index from the workspace. Takes a while for a large folder.")
    async def reindex() -> Status:
        try:
            return await index.reindex()
        except (ReindexInProgressError, ReindexTimeoutError, EmbeddingError) as err:
            raise ToolError(str(err)) from None

    @server.tool(description="When the index was last built, and how much it holds.")
    def status() -> Status:
        return index.status()

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


def create_app(settings: Settings, index: Index):
    # Stateless, with plain JSON responses: 8Rack opens a connection per call and needs nothing held
    # between calls. Listening on 127.0.0.1 also turns on the SDK's Host/Origin check, which stops a web
    # page from reaching this server through DNS rebinding.
    app = create_server(index).streamable_http_app(stateless_http=True, json_response=True, host=HOST)
    return BearerTokenMiddleware(app, settings.token)
