from pathlib import Path

import pytest
from mcp import Client

from conftest import TOKEN, keyword_embed
from rag_server.index import Index
from rag_server.ollama import EmbeddingError
from rag_server.server import BearerTokenMiddleware, create_server


@pytest.fixture
def server(settings):
    return create_server(Index(settings, keyword_embed))


@pytest.mark.anyio
async def test_offers_search_reindex_and_status(server):
    async with Client(server) as client:
        assert {t.name for t in (await client.list_tools()).tools} == {"search", "reindex", "status"}


@pytest.mark.anyio
async def test_reindex_and_search_return_structured_results(server, workspace: Path):
    (workspace / "apples.txt").write_text("apple apple")

    async with Client(server) as client:
        status = (await client.call_tool("reindex", {})).structured_content
        results = (await client.call_tool("search", {"query": "apple", "top_k": 50})).structured_content["results"]

    assert status["chunkCount"] == 1
    assert results[0]["filePath"] == "apples.txt"


@pytest.mark.anyio
@pytest.mark.parametrize(("query", "message"), [("   ", "must not be empty"), ("x" * 2001, "at most 2000")])
async def test_a_bad_query_is_a_tool_error(server, query, message):
    async with Client(server) as client:
        result = await client.call_tool("search", {"query": query})
    assert result.is_error
    assert message in result.content[0].text


@pytest.mark.anyio
async def test_an_embedding_failure_reaches_the_caller_as_a_tool_error(settings, workspace: Path):
    async def ollama_down(texts):
        raise EmbeddingError("Can't reach Ollama at http://127.0.0.1:11434 (Connection refused)")

    (workspace / "apples.txt").write_text("apple")
    async with Client(create_server(Index(settings, ollama_down))) as client:
        result = await client.call_tool("reindex", {})
    assert result.is_error
    assert "Can't reach Ollama" in result.content[0].text


async def call(middleware, headers: list[tuple[bytes, bytes]]):
    sent = []

    async def receive():
        return {"type": "http.request", "body": b""}

    async def send(message):
        sent.append(message)

    await middleware({"type": "http", "headers": headers}, receive, send)
    return sent


async def passthrough(scope, receive, send):
    await send({"type": "http.response.start", "status": 200, "headers": []})


@pytest.mark.anyio
@pytest.mark.parametrize(
    "headers",
    [[], [(b"authorization", b"Bearer wrong-token-value-here")], [(b"authorization", TOKEN.encode())]],
)
async def test_requests_without_the_exact_token_get_401(headers):
    sent = await call(BearerTokenMiddleware(passthrough, TOKEN), headers)
    assert sent[0]["status"] == 401


@pytest.mark.anyio
async def test_the_right_token_reaches_the_app():
    sent = await call(BearerTokenMiddleware(passthrough, TOKEN), [(b"authorization", f"Bearer {TOKEN}".encode())])
    assert sent[0]["status"] == 200


@pytest.mark.anyio
async def test_lifespan_events_pass_through_without_a_token():
    seen = []

    async def app(scope, receive, send):
        seen.append(scope["type"])

    await BearerTokenMiddleware(app, TOKEN)({"type": "lifespan"}, None, None)
    assert seen == ["lifespan"]
