import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "../..");

// CORS_ORIGIN only restricts browser cross-origin *reads* - a wildcard doesn't just relax that,
// it defeats it outright, and this API has no auth to fall back on. Fail fast rather than accept
// it silently (was previously accepted with no warning - see the DNS-rebinding audit finding).
if (process.env.CORS_ORIGIN === "*") {
  throw new Error(
    'CORS_ORIGIN=* is not allowed - this API has no auth, so a wildcard origin would let any ' +
      "website's browser-side fetch() call every tool-execution/scan/orchestrator endpoint. Set " +
      "CORS_ORIGIN to the frontend's real origin (default http://localhost:5173).",
  );
}

/** A blank value (.env.example ships several `KEY=` lines) or a typo must fall back to the default -
 * Number("") is 0, which would silently set e.g. the concurrency cap to "nothing can ever run". */
function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.warn(`[env] ignoring non-numeric ${name}="${raw}", using ${fallback}`);
    return fallback;
  }
  return value;
}

const DEFAULT_HOST = "127.0.0.1";
const port = numberFromEnv("PORT", 3001);
const host = process.env.HOST ?? DEFAULT_HOST;

export const env = {
  port,
  /** Defaults to loopback-only - this app has no auth by design (see CLAUDE.md), so binding wider
   * than localhost would expose every tool-execution/scan/orchestrator endpoint to anything else
   * on the same network. CORS_ORIGIN only restricts browser cross-origin fetches, not a raw
   * request from another device, so it can't substitute for this. Set HOST explicitly (e.g. "0.0.0.0")
   * to opt into LAN access. */
  host,
  /** DNS-rebinding defense (see middleware/hostCheck.ts): a page from an attacker-controlled origin
   * can point a short-TTL DNS record at 127.0.0.1, making its own fetch() same-origin to this
   * server and bypassing CORS entirely - CORS only inspects the request's Origin header, not the
   * Host it was actually sent to. Only enforced in the default loopback-only mode, since that's
   * the mode whose safety claim rebinding actually breaks; HOST set to anything else is already an
   * informed opt-in to wider exposure (see the `host` comment above), and this app has no auth to
   * guess a safe LAN allowlist for anyway. Override explicitly with ALLOWED_HOSTS (comma-separated
   * Host header values, including port) if the default is wrong for your setup. `null` = not
   * enforced. */
  allowedHosts: process.env.ALLOWED_HOSTS
    ? new Set(
        process.env.ALLOWED_HOSTS.split(",")
          .map((h) => h.trim().toLowerCase())
          .filter(Boolean),
      )
    : host === DEFAULT_HOST
      ? new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`])
      : null,
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  /** Exec tools (filesystem, bash, python, git, etc.) are confined to this directory. Also the
   * folder the RAG knowledge base indexes (see services/ragIndex.ts). */
  workspaceRoot: path.resolve(BACKEND_ROOT, process.env.WORKSPACE_ROOT || "workspace"),
  /** Must be a model with Ollama's `embedding` capability — most chat/coder models don't have it
   * and /api/embed rejects them outright. Default (nomic-embed-text) needs a manual `ollama pull`. */
  embeddingModel: process.env.EMBEDDING_MODEL ?? "nomic-embed-text",
  /** Orchestrator loop-prevention caps — see services/orchestrator.ts. */
  maxOrchestratorToolCalls: numberFromEnv("MAX_ORCHESTRATOR_TOOL_CALLS", 20),
  maxOrchestratorTaskTimeMs: numberFromEnv("MAX_ORCHESTRATOR_TASK_TIME_MS", 10 * 60 * 1000),
  /** Global cap on real OS processes spawned at once via the Tool Execution Framework - shared
   * across every caller (manual requests, Orchestrator tasks, Scan Profiles), since they all funnel
   * through the same runRecord() chokepoint in services/toolManager.ts. Guards against fork/memory
   * exhaustion from many confirmed executions landing at once; not a queue - a confirm beyond the
   * cap fails fast with a clear error so the human can retry once a slot frees up. */
  maxConcurrentExecutions: numberFromEnv("MAX_CONCURRENT_EXECUTIONS", 5),
  /** Optional NVD API key (see services/cveLookup.ts) — raises the CVE-lookup rate limit from
   * 5 req/30s to 50 req/30s. Free to request at https://nvd.nist.gov/developers/request-an-api-key.
   * Lookups work fine unauthenticated at the lower limit if this is left unset. */
  nvdApiKey: process.env.NVD_API_KEY || undefined,
  /** Bounds the one outbound internet call this app ever makes (services/cveLookup.ts) - a
   * dead-but-open connection to NVD would otherwise hang a lookup indefinitely. */
  nvdRequestTimeoutMs: numberFromEnv("NVD_REQUEST_TIMEOUT_MS", 15_000),
  /** Bounds Ollama's quick, non-generation calls (/api/tags, /api/embed - services/ollama.ts) - a
   * wedged Ollama process (e.g. mid model-load) would otherwise hang these indefinitely. Not used
   * for /api/chat, which can legitimately run far longer than this on a large local model - see
   * ollamaChatIdleTimeoutMs below. */
  ollamaRequestTimeoutMs: numberFromEnv("OLLAMA_REQUEST_TIMEOUT_MS", 60_000),
  /** Bounds a /api/chat stream by *inactivity*, not total duration - the timer resets on every
   * chunk received, so a large local model that's still slowly producing tokens is never killed by
   * this, only a connection that has gone genuinely silent (a wedged/dead Ollama process). Mirrors
   * the frontend's own IDLE_TIMEOUT_MS (frontend/src/hooks/useChat.ts) for the same reasoning. */
  ollamaChatIdleTimeoutMs: numberFromEnv("OLLAMA_CHAT_IDLE_TIMEOUT_MS", 5 * 60 * 1000),
};
