import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { env } from "../config/env.js";
import { embed } from "./ollama.js";
import type { RagChunk, RagIndexStatus, RagSearchResult } from "../types/rag.js";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAG_DIR = path.resolve(__dirname, "../../data/rag");
const INDEX_FILE = path.join(RAG_DIR, "index.json");

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "__pycache__"]);
const MAX_FILE_BYTES = 500 * 1024;
/** PDFs are indexed by their extracted *text*, so the raw binary can be much larger than a text
 * file for a comparable amount of content - hence a far higher cap than MAX_FILE_BYTES. */
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const CHUNK_LINES = 50;
const CHUNK_OVERLAP_LINES = 5;
/** Keeps individual /api/embed requests bounded rather than sending an entire codebase's chunks
 * in one call. */
const EMBED_BATCH_SIZE = 32;

let chunks: RagChunk[] = [];
let status: RagIndexStatus = {
  indexedAt: null,
  fileCount: 0,
  chunkCount: 0,
  embeddingModel: env.embeddingModel,
  workspaceRoot: env.workspaceRoot,
};

/** Crude but cheap binary-file heuristic: a null byte essentially never appears in real text. */
function isBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function isPdf(name: string): boolean {
  return name.toLowerCase().endsWith(".pdf");
}

/** Extracts a PDF's text via the poppler `pdftotext` CLI - shelling out (the same pattern the
 * ExecTool framework already uses) rather than pulling in a JS PDF-parsing dependency. `-q`
 * silences its diagnostics; `-` writes plain text to stdout. Returns undefined when pdftotext isn't
 * installed or errors, so the PDF is skipped with a logged reason instead of being indexed as the
 * binary garbage a raw utf-8 decode would produce. */
async function extractPdfText(absPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("pdftotext", ["-q", absPath, "-"], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    });
    return stdout;
  } catch (err) {
    console.error(
      `[rag] pdftotext failed for "${absPath}" - is poppler (pdftotext) installed? Skipping this file.`,
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
}

async function walkWorkspace(): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      // Hidden entries (.git, .venv, .env, ...) are skipped wholesale - both to avoid noise and,
      // for files, to avoid ever embedding something like a .env into the (persisted) index.
      if (entry.name.startsWith(".")) continue;

      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        try {
          const s = await stat(full);
          const cap = isPdf(entry.name) ? MAX_PDF_BYTES : MAX_FILE_BYTES;
          if (s.size > cap) continue;
        } catch {
          continue;
        }
        results.push(full);
      }
    }
  }

  await walk(env.workspaceRoot);
  return results;
}

/** Splits a file's text into overlapping line-based chunks. Exported for direct unit testing of
 * the line/overlap math without needing real files or a running Ollama. */
export function chunkText(text: string): { startLine: number; endLine: number; text: string }[] {
  const lines = text.split("\n");
  const result: { startLine: number; endLine: number; text: string }[] = [];
  const step = CHUNK_LINES - CHUNK_OVERLAP_LINES;

  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + CHUNK_LINES, lines.length);
    const slice = lines.slice(start, end);
    if (slice.some((l) => l.trim() !== "")) {
      result.push({ startLine: start + 1, endLine: end, text: slice.join("\n") });
    }
    if (end >= lines.length) break;
  }

  return result;
}

/** Exported for direct unit testing of the ranking math without a running Ollama. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function embedBatched(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    results.push(...(await embed(env.embeddingModel, batch)));
  }
  return results;
}

/** Rebuilds the whole index from scratch - walk, chunk, embed, persist. No incremental updates;
 * a bounded review folder is small enough that a full rebuild is simple, correct, and fast
 * enough, without stale-chunk bookkeeping. */
export async function reindex(): Promise<RagIndexStatus> {
  const files = await walkWorkspace();
  const pending: { filePath: string; startLine: number; endLine: number; text: string }[] = [];

  for (const absPath of files) {
    let text: string;
    if (isPdf(absPath)) {
      // PDFs are binary and over the text cap, so they go through pdftotext rather than a raw read.
      const extracted = await extractPdfText(absPath);
      if (extracted === undefined) continue;
      text = extracted;
    } else {
      let buf: Buffer;
      try {
        buf = await readFile(absPath);
      } catch {
        continue;
      }
      if (isBinary(buf)) continue;
      text = buf.toString("utf-8");
    }

    const relPath = path.relative(env.workspaceRoot, absPath);
    for (const chunk of chunkText(text)) {
      pending.push({ filePath: relPath, ...chunk });
    }
  }

  const embeddings = pending.length > 0 ? await embedBatched(pending.map((c) => c.text)) : [];

  chunks = pending.map((c, i) => ({
    id: `${c.filePath}:${c.startLine}-${c.endLine}`,
    filePath: c.filePath,
    startLine: c.startLine,
    endLine: c.endLine,
    text: c.text,
    embedding: embeddings[i] ?? [],
  }));

  status = {
    indexedAt: Date.now(),
    fileCount: new Set(pending.map((c) => c.filePath)).size,
    chunkCount: chunks.length,
    embeddingModel: env.embeddingModel,
    workspaceRoot: env.workspaceRoot,
  };

  await mkdir(RAG_DIR, { recursive: true });
  await writeFile(INDEX_FILE, JSON.stringify({ status, chunks }, null, 2));

  return status;
}

export function getStatus(): RagIndexStatus {
  return status;
}

export async function search(query: string, topK = 5): Promise<RagSearchResult[]> {
  if (chunks.length === 0) return [];

  const [queryEmbedding] = await embed(env.embeddingModel, [query]);
  return chunks
    .map((c) => ({
      filePath: c.filePath,
      startLine: c.startLine,
      endLine: c.endLine,
      text: c.text,
      score: cosineSimilarity(queryEmbedding, c.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/** Hydrates the in-memory index from disk - called once at server startup so a restart doesn't
 * force re-embedding a whole folder (same convention as orchestrator.ts#loadTasksFromDisk). */
export async function loadIndexFromDisk(): Promise<void> {
  try {
    const raw = await readFile(INDEX_FILE, "utf-8");
    const data = JSON.parse(raw) as { status: RagIndexStatus; chunks: RagChunk[] };
    status = data.status;
    chunks = data.chunks;
  } catch {
    // No index on disk yet - status/chunks stay at their empty defaults.
  }
}
