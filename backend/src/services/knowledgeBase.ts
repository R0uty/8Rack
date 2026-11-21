import { env } from "../config/env.js";
import * as local from "./ragIndex.js";
import { callTool } from "./mcpClient.js";
import { McpRequestError } from "./errors.js";
import type { RagIndexStatus, RagSearchResult } from "../types/rag.js";

/**
 * The knowledge base agents search and the Tools page shows: either the RAG MCP server named by
 * MCP_RAG_SERVER (mcp-servers/rag/), or - when that's unset - the local index in ragIndex.ts. The rest
 * of 8Rack calls this, never either one directly.
 *
 * Agents reach the server only through the search_knowledge_base pseudo-tool, so none of the server's
 * own tool names or descriptions ever reach the model.
 */

/** Longer than the server's own 5-minute ceiling, so its clearer timeout message arrives first. */
const REINDEX_TIMEOUT_MS = 6 * 60 * 1000;
/** A chunk is 50 lines; anything far longer is a misbehaving server, not a real chunk. */
const MAX_RESULT_TEXT_CHARS = 20_000;
const MAX_RESULTS = 20;

/** The last status the server returned - kept so the Orchestrator's tool list can be built without a
 * network call. Refreshed at startup, on every status request, and after a reindex. */
let remoteStatus: RagIndexStatus | null = null;

function invalid(serverId: string, what: string): McpRequestError {
  return new McpRequestError(`MCP server "${serverId}" returned an invalid ${what}`);
}

function parseStatus(serverId: string, value: Record<string, unknown>): RagIndexStatus {
  const { indexedAt, fileCount, chunkCount, embeddingModel, workspaceRoot } = value;
  if (
    !(indexedAt === null || typeof indexedAt === "number") ||
    typeof fileCount !== "number" ||
    typeof chunkCount !== "number" ||
    typeof embeddingModel !== "string" ||
    typeof workspaceRoot !== "string"
  ) {
    throw invalid(serverId, "status");
  }
  return { indexedAt, fileCount, chunkCount, embeddingModel, workspaceRoot, server: serverId };
}

function parseResults(serverId: string, value: Record<string, unknown>, topK: number): RagSearchResult[] {
  if (!Array.isArray(value.results)) throw invalid(serverId, "search result");
  return value.results.slice(0, Math.min(topK, MAX_RESULTS)).map((r: unknown) => {
    const { filePath, startLine, endLine, text, score } = (r ?? {}) as Record<string, unknown>;
    if (
      typeof filePath !== "string" ||
      typeof startLine !== "number" ||
      typeof endLine !== "number" ||
      typeof text !== "string" ||
      typeof score !== "number"
    ) {
      throw invalid(serverId, "search result");
    }
    return { filePath, startLine, endLine, text: text.slice(0, MAX_RESULT_TEXT_CHARS), score };
  });
}

/** Last known status, without a network call. For the server, "not indexed" until it has answered once. */
export function getStatus(): RagIndexStatus {
  const serverId = env.mcpRagServer;
  if (!serverId) return local.getStatus();
  return (
    remoteStatus ?? {
      indexedAt: null,
      fileCount: 0,
      chunkCount: 0,
      embeddingModel: env.embeddingModel,
      workspaceRoot: "",
      server: serverId,
    }
  );
}

/** Fresh status - asks the server when there is one. */
export async function refreshStatus(): Promise<RagIndexStatus> {
  const serverId = env.mcpRagServer;
  if (!serverId) return local.getStatus();
  remoteStatus = parseStatus(serverId, await callTool(serverId, "status", {}));
  return remoteStatus;
}

export async function reindex(): Promise<RagIndexStatus> {
  const serverId = env.mcpRagServer;
  if (!serverId) return local.reindex();
  remoteStatus = parseStatus(serverId, await callTool(serverId, "reindex", {}, REINDEX_TIMEOUT_MS));
  return remoteStatus;
}

export async function search(query: string, topK = 5): Promise<RagSearchResult[]> {
  const serverId = env.mcpRagServer;
  if (!serverId) return local.search(query, topK);
  return parseResults(serverId, await callTool(serverId, "search", { query, top_k: topK }), topK);
}
