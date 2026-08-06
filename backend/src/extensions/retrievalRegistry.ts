import { search } from "../services/ragIndex.js";
import type { RetrievalSource, RetrievedDocument } from "../types/rag.js";

const sources: RetrievalSource[] = [];

export function registerRetrievalSource(source: RetrievalSource): void {
  sources.push(source);
}

export function listRetrievalSources(): string[] {
  return sources.map((s) => s.name);
}

/** Default source: the workspace codebase's RAG index (see services/ragIndex.ts). Any
 * additionally registered sources are queried too, results pooled and left unsorted across
 * sources (each source's own scores aren't necessarily comparable) - callers wanting a single
 * ranked list should query one source directly instead. */
export async function retrieve(query: string, topK = 5): Promise<RetrievedDocument[]> {
  const workspaceResults = (await search(query, topK)).map((r) => ({
    id: `${r.filePath}:${r.startLine}-${r.endLine}`,
    content: r.text,
    score: r.score,
    metadata: { filePath: r.filePath, startLine: r.startLine, endLine: r.endLine },
  }));

  const fromOtherSources = (await Promise.all(sources.map((s) => s.retrieve(query, topK)))).flat();

  return [...workspaceResults, ...fromOtherSources];
}
