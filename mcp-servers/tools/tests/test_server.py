import pytest
from mcp import Client

from conftest import TEST_CATALOG, TOKEN
from tools_server.server import BearerTokenMiddleware, create_server


@pytest.fixture
def server(settings):
    return create_server(settings, TEST_CATALOG)


@pytest.mark.anyio
async def test_offers_one_tool_per_catalog_entry(server):
    async with Client(server) as client:
        assert {t.name for t in (await client.list_tools()).tools} == {"echo_test", "sleep_test", "missing_test"}


@pytest.mark.anyio
async def test_calling_a_tool_runs_it_and_returns_structured_output(server):
    async with Client(server) as client:
        result = await client.call_tool("echo_test", {"args": ["hello"]})
    assert result.structured_content["success"] is True
    assert result.structured_content["stdout"].strip() == "hello"


@pytest.mark.anyio
async def test_a_tool_with_no_args_still_runs(server):
    async with Client(server) as client:
        result = await client.call_tool("echo_test", {})
    assert result.structured_content["success"] is True


@pytest.mark.anyio
async def test_a_missing_binary_reaches_the_caller_as_a_tool_error(server):
    async with Client(server) as client:
        result = await client.call_tool("missing_test", {"args": []})
    assert result.is_error
    assert "is not installed" in result.content[0].text


@pytest.mark.anyio
async def test_a_path_escape_is_a_tool_error(server):
    async with Client(server) as client:
        result = await client.call_tool("echo_test", {"args": ["../../etc/passwd"]})
    assert result.is_error
    assert "outside the workspace root" in result.content[0].text


async def call(middleware, headers):
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
