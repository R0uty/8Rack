import json
import os
from pathlib import Path

import anyio
import pytest

from conftest import keyword_embed
from rag_server.index import (
    MAX_FILE_BYTES,
    Index,
    ReindexInProgressError,
    chunk_text,
    cosine_similarity,
    read_text,
    walk_workspace,
)
from rag_server.ollama import EmbeddingError


def test_chunks_overlap_by_five_lines_like_the_typescript_index():
    text = "\n".join(f"line {i}" for i in range(1, 121))
    assert [(s, e) for s, e, _ in chunk_text(text)] == [(1, 50), (46, 95), (91, 120)]


def test_blank_chunks_are_dropped_and_short_text_is_one_chunk():
    assert chunk_text("\n\n\n") == []
    assert chunk_text("one\ntwo") == [(1, 2, "one\ntwo")]


def test_cosine_similarity():
    assert cosine_similarity([1, 0], [1, 0]) == pytest.approx(1)
    assert cosine_similarity([1, 0], [0, 1]) == pytest.approx(0)
    assert cosine_similarity([0, 0], [1, 1]) == 0


def test_walk_skips_hidden_vendored_oversized_and_symlinked_entries(workspace: Path, tmp_path: Path):
    (workspace / "app.py").write_text("print(1)")
    (workspace / ".env").write_text("SECRET=1")
    (workspace / ".git").mkdir()
    (workspace / ".git" / "config").write_text("x")
    (workspace / "node_modules").mkdir()
    (workspace / "node_modules" / "lib.js").write_text("x")
    (workspace / "big.txt").write_bytes(b"a" * (MAX_FILE_BYTES + 1))
    outside = tmp_path / "outside.txt"
    outside.write_text("not in the workspace")
    os.symlink(outside, workspace / "link.txt")
    os.symlink(tmp_path, workspace / "linkdir")

    assert walk_workspace(workspace, ()) == [workspace / "app.py"]


def test_walk_never_enters_an_excluded_folder(workspace: Path):
    (workspace / "keep.txt").write_text("x")
    (workspace / "missions").mkdir()
    (workspace / "missions" / "scope.json").write_text("target")

    assert walk_workspace(workspace, (workspace / "missions",)) == [workspace / "keep.txt"]
    assert walk_workspace(workspace / "missions", (workspace,)) == []


def test_binary_files_are_skipped(workspace: Path):
    path = workspace / "image.bin"
    path.write_bytes(b"\x89PNG\0\0data")
    assert read_text(path) is None


@pytest.mark.anyio
async def test_reindex_then_search_ranks_the_closest_chunk_first(settings, workspace: Path):
    (workspace / "apples.txt").write_text("apple apple apple")
    (workspace / "bananas.txt").write_text("banana banana")
    index = Index(settings, keyword_embed)

    status = await index.reindex()
    results = await index.search("apple", 5)

    assert status["fileCount"] == 2 and status["chunkCount"] == 2
    assert [r["filePath"] for r in results] == ["apples.txt", "bananas.txt"]


@pytest.mark.anyio
async def test_the_saved_index_is_loaded_after_a_restart(settings, workspace: Path):
    (workspace / "apples.txt").write_text("apple")
    await Index(settings, keyword_embed).reindex()

    restarted = Index(settings, keyword_embed)
    restarted.load()

    assert restarted.status()["chunkCount"] == 1
    assert (await restarted.search("apple", 1))[0]["filePath"] == "apples.txt"
    assert json.loads(settings.index_file.read_text())["status"]["chunkCount"] == 1


@pytest.mark.anyio
async def test_a_failed_reindex_keeps_the_previous_index(settings, workspace: Path):
    (workspace / "apples.txt").write_text("apple")
    index = Index(settings, keyword_embed)
    await index.reindex()

    async def broken(texts):
        raise EmbeddingError("Ollama is down")

    index._embed = broken
    (workspace / "bananas.txt").write_text("banana")
    with pytest.raises(EmbeddingError):
        await index.reindex()

    assert index.status()["fileCount"] == 1
    assert len(index._chunks) == 1


@pytest.mark.anyio
async def test_a_second_reindex_is_refused_while_one_runs(settings, workspace: Path):
    (workspace / "apples.txt").write_text("apple")
    release = anyio.Event()

    async def slow(texts):
        await release.wait()
        return await keyword_embed(texts)

    index = Index(settings, slow)
    async with anyio.create_task_group() as tg:
        tg.start_soon(index.reindex)
        await anyio.sleep(0.1)
        with pytest.raises(ReindexInProgressError):
            await index.reindex()
        release.set()


@pytest.mark.anyio
async def test_search_on_an_empty_index_returns_nothing_without_embedding(settings):
    async def must_not_run(texts):
        raise AssertionError("embedded with no index")

    assert await Index(settings, must_not_run).search("anything", 5) == []
