import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "../..");

export const env = {
  port: Number(process.env.PORT ?? 3001),
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  /** Exec tools (filesystem, bash, python, git, etc.) are confined to this directory. */
  workspaceRoot: path.resolve(BACKEND_ROOT, process.env.WORKSPACE_ROOT || "workspace"),
  /** Orchestrator loop-prevention caps — see services/orchestrator.ts. */
  maxOrchestratorToolCalls: Number(process.env.MAX_ORCHESTRATOR_TOOL_CALLS ?? 10),
  maxOrchestratorTaskTimeMs: Number(process.env.MAX_ORCHESTRATOR_TASK_TIME_MS ?? 10 * 60 * 1000),
};
