"""Runs the server: python -m rag_server"""

from __future__ import annotations

import sys

import uvicorn

from .config import HOST, ConfigError, load_settings
from .index import Index
from .ollama import make_embedder
from .server import create_app


def main() -> None:
    try:
        settings = load_settings()
    except ConfigError as err:
        print(f"rag-server: {err}", file=sys.stderr)
        sys.exit(2)

    index = Index(settings, make_embedder(settings.ollama_base_url, settings.embedding_model, settings.ollama_timeout_s))
    index.load()
    status = index.status()
    print(
        f"rag-server: indexing {settings.workspace_root} with {settings.embedding_model}; "
        + (f"{status['chunkCount']} chunk(s) loaded" if status["indexedAt"] else "no index yet - call reindex")
    )
    uvicorn.run(create_app(settings, index), host=HOST, port=settings.port, log_level="info")


if __name__ == "__main__":
    main()
