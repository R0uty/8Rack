/** Extension point for future retrieval-augmented generation. Not implemented yet. */

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
