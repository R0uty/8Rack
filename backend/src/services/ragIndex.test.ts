import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
}));
vi.mock("./ollama.js", () => ({ embed: vi.fn() }));

import { chunkText, cosineSimilarity, loadIndexFromDisk, reindex, search } from "./ragIndex.js";
import { embed } from "./ollama.js";
import { RagReindexInProgressError } from "./errors.js";
import { env } from "../config/env.js";
import * as fsPromises from "node:fs/promises";
import path from "node:path";
import type { RagChunk } from "../types/rag.js";

const mockEmbed = vi.mocked(embed);
const mockReadFile = vi.mocked(fsPromises.readFile);
const mockReaddir = vi.mocked(fsPromises.readdir);
const mockStat = vi.mocked(fsPromises.stat);

function fixtureChunk(overrides: Partial<RagChunk> = {}): RagChunk {
  return {
    id: "a.ts:1-10",
    filePath: "a.ts",
    startLine: 1,
    endLine: 10,
    text: "const a = 1;",
    embedding: [1, 0, 0],
    ...overrides,
  };
}

// ragIndex.ts's index is module-level state with no exported reset, so these two describe blocks
// deliberately run first (vitest runs a file's tests in declaration order) - before any other
// test in this file loads real chunks in. Same tradeoff agentManager.test.ts documents for its
// own module-level cache.
describe("search - before any index is loaded", () => {
  it("returns [] without calling embed when the index is empty", async () => {
    const results = await search("anything");
    expect(results).toEqual([]);
    expect(mockEmbed).not.toHaveBeenCalled();
  });
});

describe("loadIndexFromDisk - no index file on disk yet", () => {
  it("leaves the index empty when the file doesn't exist", async () => {
    mockReadFile.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    await loadIndexFromDisk();

    const results = await search("anything");
    expect(results).toEqual([]);
  });
});

describe("chunkText", () => {
  it("returns a single chunk for text shorter than the chunk size", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 10 });
  });

  it("splits longer text into overlapping chunks", () => {
    const text = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n");
    const chunks = chunkText(text);
    expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([
      [1, 50],
      [46, 95],
      [91, 120],
    ]);
  });

  it("skips chunks that are entirely blank", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("\n\n\n")).toEqual([]);
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("is 0 (not NaN) when either vector is all zeros", () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });
});

describe("search - ranking (index populated via loadIndexFromDisk)", () => {
  it("ranks stored chunks by cosine similarity to the embedded query", async () => {
    const chunks: RagChunk[] = [
      fixtureChunk({ id: "close", filePath: "close.ts", embedding: [1, 0, 0] }),
      fixtureChunk({ id: "far", filePath: "far.ts", embedding: [0, 1, 0] }),
      fixtureChunk({ id: "medium", filePath: "medium.ts", embedding: [0.7, 0.7, 0] }),
    ];
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        status: { indexedAt: 1, fileCount: 3, chunkCount: 3, embeddingModel: "m", workspaceRoot: "/w" },
        chunks,
      }),
    );
    await loadIndexFromDisk();

    mockEmbed.mockResolvedValueOnce([[1, 0, 0]]);
    const results = await search("query", 3);

    expect(results.map((r) => r.filePath)).toEqual(["close.ts", "medium.ts", "far.ts"]);
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[1].score).toBeGreaterThan(results[2].score);
  });

  it("respects topK", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        status: { indexedAt: 1, fileCount: 2, chunkCount: 2, embeddingModel: "m", workspaceRoot: "/w" },
        chunks: [fixtureChunk({ id: "a" }), fixtureChunk({ id: "b", filePath: "b.ts" })],
      }),
    );
    await loadIndexFromDisk();

    mockEmbed.mockResolvedValueOnce([[1, 0, 0]]);
    const results = await search("query", 1);

    expect(results).toHaveLength(1);
  });
});

describe("reindex coordination", () => {
  it("refuses a second reindex while one is in flight", async () => {
    mockReaddir.mockResolvedValueOnce([
      { name: "notes.txt", isDirectory: () => false, isFile: () => true } as never,
    ]);
    mockStat.mockResolvedValueOnce({ size: 10 } as never);
    mockReadFile.mockResolvedValueOnce("line one\nline two\n");

    let releaseEmbed: (v: number[][]) => void;
    mockEmbed.mockReturnValueOnce(
      new Promise<number[][]>((resolve) => {
        releaseEmbed = resolve;
      }),
    );

    const first = reindex();
    await expect(reindex()).rejects.toThrow(RagReindexInProgressError);

    releaseEmbed!([[1, 0, 0]]);
    await first;
  });
});

describe("reindex app-data exclusion", () => {
  it("never indexes anything under the app's own data dir, even when it's inside the workspace", async () => {
    // WORKSPACE_ROOT pointed at the repo root for a moment - the walk must not descend into
    // backend/data. readdir only returns the "data" entry at the root; isInsideAppData skips it.
    const original = env.workspaceRoot;
    env.workspaceRoot = path.resolve(env.workspaceRoot, "..");
    try {
      mockEmbed.mockClear();
      mockReaddir.mockResolvedValueOnce([
        { name: "data", isDirectory: () => true, isFile: () => false } as never,
      ]);

      const status = await reindex();

      expect(status.fileCount).toBe(0);
      expect(mockEmbed).not.toHaveBeenCalled();
    } finally {
      env.workspaceRoot = original;
    }
  });
});
