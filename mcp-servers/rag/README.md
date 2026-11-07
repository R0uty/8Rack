# 8Rack RAG MCP server

The knowledge base as an MCP server: it indexes a folder, embeds it through local Ollama, and offers
three tools over streamable HTTP - `search`, `reindex` and `status`. 8Rack uses it in place of its
built-in index when `MCP_RAG_SERVER` names it (see `backend/.env.example`). Agents still reach it
only through their `search_knowledge_base` tool; none of this server's tool descriptions are shown
to the model.

It runs on the same machine as 8Rack and Ollama, listens on 127.0.0.1 only, and refuses any request
without the bearer token.

## Run it

Needs Python 3.11+ and an embedding model in Ollama (`ollama pull nomic-embed-text`).

```bash
cd mcp-servers/rag
python3 -m venv .venv
.venv/bin/pip install -e '.[test]'
cp .env.example .env    # set RAG_MCP_TOKEN and RAG_WORKSPACE_ROOT
.venv/bin/python -m rag_server
```

Then in `backend/.env`:

```bash
MCP_SERVERS=rag=http://127.0.0.1:8766/mcp
MCP_TOKEN_RAG=<the same value as RAG_MCP_TOKEN>
MCP_RAG_SERVER=rag
```

Restart the backend and press Reindex on Tools → Knowledge base.

## Tests

```bash
.venv/bin/python -m pytest -q
```

## What it indexes

The same rules as the backend's built-in index: text files under `RAG_WORKSPACE_ROOT`, in 50-line
chunks overlapping by 5 lines. It skips hidden files and folders, symlinks, `node_modules`, `dist`,
`build` and `__pycache__`, files over 500 KB (PDFs over 25 MB, read with `pdftotext`), binaries,
its own index folder, and 8Rack's `backend/data`. A reindex rebuilds everything and replaces the old
index only once it succeeds.
