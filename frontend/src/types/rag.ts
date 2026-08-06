export interface RagIndexStatus {
  indexedAt: number | null;
  fileCount: number;
  chunkCount: number;
  embeddingModel: string;
  workspaceRoot: string;
}
