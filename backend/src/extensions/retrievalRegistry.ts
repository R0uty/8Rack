import type { RetrievalSource, RetrievedDocument } from "../types/rag.js";

const sources: RetrievalSource[] = [];

export function registerRetrievalSource(source: RetrievalSource): void {
  sources.push(source);
}

export function listRetrievalSources(): string[] {
  return sources.map((s) => s.name);
}

export async function retrieve(_query: string, _topK?: number): Promise<RetrievedDocument[]> {
  return [];
}
