/** Retrieval-augmented generation over a workspace codebase - see services/ragIndex.ts. */

export interface RetrievedDocument {
  id: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface RetrievalSource {
  name: string;
  retrieve: (query: string, topK?: number) => Promise<RetrievedDocument[]>;
}

/** One embedded chunk of a workspace file. */
export interface RagChunk {
  id: string;
  /** Relative to env.workspaceRoot. */
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
  embedding: number[];
}

export interface RagIndexStatus {
  indexedAt: number | null;
  fileCount: number;
  chunkCount: number;
  embeddingModel: string;
  /** As the index's owner sees it - for an MCP server, a path on that server's machine. */
  workspaceRoot: string;
  /** The MCP server serving this index (MCP_RAG_SERVER). Absent for the local index. */
  server?: string;
}

export interface RagSearchResult {
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
  score: number;
}
