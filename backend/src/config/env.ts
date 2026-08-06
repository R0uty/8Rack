import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "../..");

export const env = {
  port: Number(process.env.PORT ?? 3001),
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  /** Exec tools (filesystem, bash, python, git, etc.) are confined to this directory. Also the
   * folder the RAG knowledge base indexes (see services/ragIndex.ts). */
  workspaceRoot: path.resolve(BACKEND_ROOT, process.env.WORKSPACE_ROOT || "workspace"),
  /** Must be a model with Ollama's `embedding` capability — most chat/coder models don't have it
   * and /api/embed rejects them outright. Default (nomic-embed-text) needs a manual `ollama pull`. */
  embeddingModel: process.env.EMBEDDING_MODEL ?? "nomic-embed-text",
  /** Orchestrator loop-prevention caps — see services/orchestrator.ts. */
  maxOrchestratorToolCalls: Number(process.env.MAX_ORCHESTRATOR_TOOL_CALLS ?? 10),
  maxOrchestratorTaskTimeMs: Number(process.env.MAX_ORCHESTRATOR_TASK_TIME_MS ?? 10 * 60 * 1000),
  /** Optional NVD API key (see services/cveLookup.ts) — raises the CVE-lookup rate limit from
   * 5 req/30s to 50 req/30s. Free to request at https://nvd.nist.gov/developers/request-an-api-key.
   * Lookups work fine unauthenticated at the lower limit if this is left unset. */
  nvdApiKey: process.env.NVD_API_KEY || undefined,
};
