"""Embeddings from local Ollama's /api/embed. Standard library only - one POST doesn't need an HTTP client
dependency."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from collections.abc import Awaitable, Callable

import anyio

Embedder = Callable[[list[str]], Awaitable[list[list[float]]]]


class EmbeddingError(Exception):
    """Ollama couldn't embed. The message says what to do about it."""


def make_embedder(base_url: str, model: str, timeout_s: float) -> Embedder:
    def post(texts: list[str]) -> list[list[float]]:
        request = urllib.request.Request(
            f"{base_url}/api/embed",
            data=json.dumps({"model": model, "input": texts}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout_s) as response:
                body = json.load(response)
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", "replace")
            if err.code == 404 or "not found" in detail.lower():
                raise EmbeddingError(f'Embedding model "{model}" isn\'t in Ollama. Run: ollama pull {model}') from None
            if "does not support" in detail.lower():
                raise EmbeddingError(f'"{model}" can\'t make embeddings. Set EMBEDDING_MODEL to an embedding model.') from None
            raise EmbeddingError(f"Ollama answered HTTP {err.code}: {detail[:300]}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            reason = getattr(err, "reason", err)
            raise EmbeddingError(f"Can't reach Ollama at {base_url} ({reason})") from None

        embeddings = body.get("embeddings") if isinstance(body, dict) else None
        if not isinstance(embeddings, list) or len(embeddings) != len(texts):
            raise EmbeddingError("Ollama returned an unexpected embedding response")
        return embeddings

    async def embed(texts: list[str]) -> list[list[float]]:
        # A blocking call in a worker thread. abandon_on_cancel lets a reindex timeout end the wait; the
        # request itself still stops at timeout_s.
        return await anyio.to_thread.run_sync(post, texts, abandon_on_cancel=True)

    return embed
