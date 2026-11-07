"""The workspace index: walk, chunk, embed, persist, search.

A port of backend/src/services/ragIndex.ts with the same limits and skip rules, so moving the knowledge
base behind MCP doesn't change what gets indexed.
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import anyio

from .config import Settings
from .ollama import Embedder

SKIP_DIRS = {"node_modules", "dist", "build", "__pycache__"}
MAX_FILE_BYTES = 500 * 1024
# PDFs are indexed by their extracted text, so the file itself can be much larger than a text file
# with the same amount of content.
MAX_PDF_BYTES = 25 * 1024 * 1024
CHUNK_LINES = 50
CHUNK_OVERLAP_LINES = 5
EMBED_BATCH_SIZE = 32
# Ceiling on one full reindex. Each embed call is bounded on its own; this caps the total.
REINDEX_TIMEOUT_S = 5 * 60


class ReindexInProgressError(Exception):
    def __init__(self) -> None:
        super().__init__("A reindex is already running. Wait for it to finish.")


class ReindexTimeoutError(Exception):
    def __init__(self) -> None:
        super().__init__(f"The reindex took longer than {REINDEX_TIMEOUT_S // 60} minutes and was stopped. The previous index is still in use.")


@dataclass
class Chunk:
    id: str
    filePath: str
    startLine: int
    endLine: int
    text: str
    embedding: list[float]


def chunk_text(text: str) -> list[tuple[int, int, str]]:
    """Overlapping line-based chunks, 1-based inclusive line numbers. Chunks with only blank lines are dropped."""
    lines = text.split("\n")
    step = CHUNK_LINES - CHUNK_OVERLAP_LINES
    chunks = []
    start = 0
    while start < len(lines):
        end = min(start + CHUNK_LINES, len(lines))
        piece = lines[start:end]
        if any(line.strip() for line in piece):
            chunks.append((start + 1, end, "\n".join(piece)))
        if end >= len(lines):
            break
        start += step
    return chunks


def cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def is_inside(candidate: Path, base: Path) -> bool:
    return candidate == base or base in candidate.parents


def walk_workspace(root: Path, excluded: tuple[Path, ...]) -> list[Path]:
    """Every indexable file under root. Hidden entries (.git, .env, ...) and symlinks are skipped - a
    symlink could point outside the workspace."""
    if any(is_inside(root, ex) for ex in excluded):
        return []
    found: list[Path] = []

    def walk(directory: Path) -> None:
        try:
            entries = sorted(os.scandir(directory), key=lambda e: e.name)
        except OSError:
            return
        for entry in entries:
            if entry.name.startswith("."):
                continue
            path = Path(entry.path)
            if entry.is_dir(follow_symlinks=False):
                if entry.name in SKIP_DIRS or any(is_inside(path, ex) for ex in excluded):
                    continue
                walk(path)
            elif entry.is_file(follow_symlinks=False):
                try:
                    size = entry.stat(follow_symlinks=False).st_size
                except OSError:
                    continue
                cap = MAX_PDF_BYTES if entry.name.lower().endswith(".pdf") else MAX_FILE_BYTES
                if size <= cap:
                    found.append(path)

    walk(root)
    return found


def read_text(path: Path) -> str | None:
    """The file's text, or None for a binary file or a PDF pdftotext can't read."""
    if path.name.lower().endswith(".pdf"):
        try:
            result = subprocess.run(["pdftotext", "-q", str(path), "-"], capture_output=True, timeout=120, check=True)
        except (OSError, subprocess.SubprocessError):
            print(f"[rag] pdftotext failed for {path} - is poppler installed? Skipping this file.")
            return None
        return result.stdout.decode("utf-8", "replace")
    try:
        data = path.read_bytes()
    except OSError:
        return None
    # A null byte essentially never appears in real text.
    if b"\0" in data[:8000]:
        return None
    return data.decode("utf-8", "replace")


class Index:
    def __init__(self, settings: Settings, embed: Embedder) -> None:
        self._settings = settings
        self._embed = embed
        self._chunks: list[Chunk] = []
        self._status = {
            "indexedAt": None,
            "fileCount": 0,
            "chunkCount": 0,
            "embeddingModel": settings.embedding_model,
            "workspaceRoot": str(settings.workspace_root),
        }
        self._lock = anyio.Lock()

    def status(self) -> dict:
        return dict(self._status)

    def load(self) -> None:
        """Restores the index saved by the last reindex, so a restart doesn't re-embed everything."""
        try:
            data = json.loads(self._settings.index_file.read_text("utf-8"))
            self._chunks = [Chunk(**c) for c in data["chunks"]]
            self._status = data["status"]
        except FileNotFoundError:
            pass

    async def _embed_batched(self, texts: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for i in range(0, len(texts), EMBED_BATCH_SIZE):
            vectors.extend(await self._embed(texts[i : i + EMBED_BATCH_SIZE]))
        return vectors

    def _collect(self) -> list[tuple[str, int, int, str]]:
        root = self._settings.workspace_root
        pending = []
        for path in walk_workspace(root, self._settings.excluded_dirs):
            text = read_text(path)
            if text is None:
                continue
            rel = str(path.relative_to(root))
            pending.extend((rel, start, end, body) for start, end, body in chunk_text(text))
        return pending

    def _save(self, status: dict, chunks: list[Chunk]) -> None:
        path = self._settings.index_file
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"status": status, "chunks": [asdict(c) for c in chunks]}), "utf-8")
        os.replace(tmp, path)

    async def reindex(self) -> dict:
        """Rebuilds the whole index. A failed or timed-out reindex leaves the previous one in use."""
        if self._lock.locked():
            raise ReindexInProgressError()
        async with self._lock:
            try:
                with anyio.fail_after(REINDEX_TIMEOUT_S):
                    pending = await anyio.to_thread.run_sync(self._collect, abandon_on_cancel=True)
                    vectors = await self._embed_batched([p[3] for p in pending]) if pending else []
            except TimeoutError:
                raise ReindexTimeoutError() from None

            chunks = [
                Chunk(id=f"{rel}:{start}-{end}", filePath=rel, startLine=start, endLine=end, text=body, embedding=vector)
                for (rel, start, end, body), vector in zip(pending, vectors)
            ]
            status = {
                "indexedAt": int(time.time() * 1000),
                "fileCount": len({c.filePath for c in chunks}),
                "chunkCount": len(chunks),
                "embeddingModel": self._settings.embedding_model,
                "workspaceRoot": str(self._settings.workspace_root),
            }
            await anyio.to_thread.run_sync(self._save, status, chunks)
            self._chunks, self._status = chunks, status
            return dict(status)

    async def search(self, query: str, top_k: int) -> list[dict]:
        if not self._chunks:
            return []
        [query_vector] = await self._embed([query])
        scored = [
            {
                "filePath": c.filePath,
                "startLine": c.startLine,
                "endLine": c.endLine,
                "text": c.text,
                "score": cosine_similarity(query_vector, c.embedding),
            }
            for c in self._chunks
        ]
        scored.sort(key=lambda r: r["score"], reverse=True)
        return scored[:top_k]
