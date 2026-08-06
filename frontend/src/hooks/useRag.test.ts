import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useRag } from "./useRag";
import { fetchRagStatus, reindex } from "../services/ragApi";
import type { RagIndexStatus } from "../types/rag";

vi.mock("../services/ragApi", () => ({ fetchRagStatus: vi.fn(), reindex: vi.fn() }));

const mockFetchRagStatus = vi.mocked(fetchRagStatus);
const mockReindex = vi.mocked(reindex);

const fixtureStatus: RagIndexStatus = {
  indexedAt: 12345,
  fileCount: 3,
  chunkCount: 10,
  embeddingModel: "nomic-embed-text",
  workspaceRoot: "/workspace",
};

describe("useRag", () => {
  it("loads status on mount", async () => {
    mockFetchRagStatus.mockResolvedValue(fixtureStatus);
    const { result } = renderHook(() => useRag());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status).toEqual(fixtureStatus);
    expect(result.current.reindexing).toBe(false);
  });

  it("surfaces a load failure", async () => {
    mockFetchRagStatus.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useRag());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("boom");
  });

  it("reindex() sets reindexing (not loading) while in flight, then updates status", async () => {
    mockFetchRagStatus.mockResolvedValue(fixtureStatus);
    const { result } = renderHook(() => useRag());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const updated = { ...fixtureStatus, chunkCount: 20 };
    let resolveReindex!: (value: RagIndexStatus) => void;
    mockReindex.mockReturnValue(new Promise((resolve) => (resolveReindex = resolve)));

    let reindexPromise!: Promise<void>;
    act(() => {
      reindexPromise = result.current.reindex();
    });
    expect(result.current.reindexing).toBe(true);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      resolveReindex(updated);
      await reindexPromise;
    });

    expect(result.current.reindexing).toBe(false);
    expect(result.current.status).toEqual(updated);
  });

  it("a reindex failure reports a reindex-specific message", async () => {
    mockFetchRagStatus.mockResolvedValue(fixtureStatus);
    const { result } = renderHook(() => useRag());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockReindex.mockRejectedValue(new Error("embedding model unavailable"));
    await act(async () => {
      await result.current.reindex();
    });

    expect(result.current.error).toBe("embedding model unavailable");
  });
});
