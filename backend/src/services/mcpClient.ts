import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { env } from "../config/env.js";
import { ExecToolNotFoundError } from "./errors.js";
import type { McpServerStatus, McpToolInfo } from "../types/mcp.js";

/**
 * 8Rack as an MCP client, step 1 of "Planned: MCP servers as the tool and RAG providers" in
 * DEVELOPMENT.md: connect to the servers named in `.env` and list the tools they offer. Nothing here
 * calls a tool - that waits for the approval gate and the enable switch (TODO.md steps 2-3).
 *
 * Each check opens a connection, lists tools and closes it again, rather than holding connections open:
 * there's nothing to reuse a connection for yet, and it means a server that restarts needs no reconnect
 * logic.
 */

export interface McpServerConfig {
  id: string;
  url: URL;
  token: string;
}

interface ConfigProblem {
  id: string;
  url: string;
  error: string;
}

const SERVER_ID = /^[a-z][a-z0-9-]{0,31}$/;
/** Tool names and descriptions come from the server and end up in front of the model, so only plain
 * names are accepted - the characters MCP itself recommends - and descriptions are capped. */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_TOOLS_PER_SERVER = 200;
const MAX_TOOL_PAGES = 20;
const MAX_DESCRIPTION_CHARS = 1000;
const MAX_ERROR_CHARS = 300;

export function tokenVariable(id: string): string {
  return `MCP_TOKEN_${id.toUpperCase().replace(/-/g, "_")}`;
}

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "[::1]" || /^127\./.test(url.hostname);
}

/**
 * Reads `MCP_SERVERS` - comma-separated `id=url` entries - and each server's token from
 * `MCP_TOKEN_<ID>`. A bad entry is reported as a problem rather than thrown, so one typo doesn't take
 * the other servers (or the backend) down with it.
 */
export function parseServerConfig(
  raw: string,
  vars: Record<string, string | undefined>,
): { servers: McpServerConfig[]; problems: ConfigProblem[] } {
  const servers: McpServerConfig[] = [];
  const problems: ConfigProblem[] = [];
  const seen = new Set<string>();

  for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
    const separator = entry.indexOf("=");
    if (separator < 1) {
      problems.push({ id: entry.slice(0, 32), url: "", error: 'Expected "id=https://host/path"' });
      continue;
    }
    const id = entry.slice(0, separator).trim();
    const rawUrl = entry.slice(separator + 1).trim();
    const problem = (error: string) => problems.push({ id, url: "", error });

    if (!SERVER_ID.test(id)) {
      problem("The id must be lowercase letters, digits and hyphens, starting with a letter");
      continue;
    }
    if (seen.has(id)) {
      problem("This id is listed more than once");
      continue;
    }
    seen.add(id);

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      problem("The URL isn't valid");
      continue;
    }
    // Shown in the UI - and a token belongs in its own variable, not in a URL that ends up in logs.
    if (url.username || url.password) {
      problem(`Remove the credentials from the URL and put the token in ${tokenVariable(id)}`);
      continue;
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) {
      problem("Use https - plain http is only allowed for localhost");
      continue;
    }
    const token = vars[tokenVariable(id)]?.trim();
    if (!token) {
      problems.push({ id, url: url.href, error: `${tokenVariable(id)} is not set` });
      continue;
    }
    servers.push({ id, url, token });
  }
  return { servers, problems };
}

function configuredServers() {
  return parseServerConfig(env.mcpServers, process.env);
}

function misconfigured(problem: ConfigProblem): McpServerStatus {
  return { ...problem, state: "misconfigured", tools: [], skippedTools: 0, checkedAt: null };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function describeError(err: unknown, server: McpServerConfig): string {
  if (err instanceof StreamableHTTPError && (err.code === 401 || err.code === 403)) {
    return `The server rejected the token (HTTP ${err.code}). Check ${tokenVariable(server.id)}.`;
  }
  if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
    return `No answer within ${env.mcpRequestTimeoutMs} ms`;
  }
  const code = (err as { cause?: { code?: unknown } })?.cause?.code;
  if (typeof code === "string") return `Can't reach the server (${code})`;
  return truncate(err instanceof Error ? err.message : String(err), MAX_ERROR_CHARS);
}

/** The catalog id 8Rack gives a server's tool - `<serverId>.<name>`. serverId already matches
 * SERVER_ID and name matches TOOL_NAME, so the result stays within the accepted characters and two
 * servers offering the same tool name never collide. */
export function qualifiedToolId(serverId: string, toolName: string): string {
  return `${serverId}.${toolName}`;
}

/** Keeps only tools with an accepted name, once each, up to the cap. `enabled` is filled in later
 * from the persisted overrides (see rebuildToolRegistry) - false here is just a placeholder. */
function acceptedTools(serverId: string, offered: { name: string; description?: string }[]): McpToolInfo[] {
  const tools: McpToolInfo[] = [];
  const names = new Set<string>();
  for (const tool of offered) {
    if (tools.length >= MAX_TOOLS_PER_SERVER) break;
    if (!TOOL_NAME.test(tool.name) || names.has(tool.name)) continue;
    names.add(tool.name);
    tools.push({
      id: qualifiedToolId(serverId, tool.name),
      name: tool.name,
      description: truncate((tool.description ?? "").trim(), MAX_DESCRIPTION_CHARS),
      enabled: false,
    });
  }
  return tools;
}

async function checkServer(server: McpServerConfig): Promise<McpServerStatus> {
  const base = { id: server.id, url: server.url.href };
  const timeout = env.mcpRequestTimeoutMs;
  const client = new Client({ name: "8rack", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(server.url, {
    requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
    // The SDK's default, set here on purpose: a redirect to another origin must not carry the token.
    redirectPolicy: "same-origin",
  });

  try {
    await client.connect(transport, { timeout });
    const offered: { name: string; description?: string }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = await client.listTools(cursor ? { cursor } : undefined, { timeout });
      offered.push(...result.tools);
      cursor = result.nextCursor;
      if (!cursor || offered.length > MAX_TOOLS_PER_SERVER) break;
    }
    const tools = acceptedTools(server.id, offered);
    return { ...base, state: "online", tools, skippedTools: offered.length - tools.length, checkedAt: Date.now() };
  } catch (err) {
    return { ...base, state: "error", error: describeError(err, server), tools: [], skippedTools: 0, checkedAt: Date.now() };
  } finally {
    await client.close().catch(() => {});
  }
}

function sortById(statuses: McpServerStatus[]): McpServerStatus[] {
  return statuses.sort((a, b) => a.id.localeCompare(b.id));
}

let lastStatuses: McpServerStatus[] | null = null;
let inFlight: Promise<McpServerStatus[]> | null = null;

/** The result of the last check, or - before the first one finishes - each configured server as
 * `checking`. */
export function listServers(): McpServerStatus[] {
  if (lastStatuses) return lastStatuses;
  const { servers, problems } = configuredServers();
  return sortById([
    ...servers.map((s): McpServerStatus => ({ id: s.id, url: s.url.href, state: "checking", tools: [], skippedTools: 0, checkedAt: null })),
    ...problems.map(misconfigured),
  ]);
}

/** Checks every configured server at once. Never rejects - a failure is that server's `error` state.
 * Concurrent calls share one check rather than opening a second round of connections. */
export function refreshServers(config = configuredServers()): Promise<McpServerStatus[]> {
  inFlight ??= (async () => {
    try {
      const checked = await Promise.all(config.servers.map(checkServer));
      lastStatuses = sortById([...checked, ...config.problems.map(misconfigured)]);
      // Rebuild the callable-tool registry from this round and stamp each tool's enabled flag onto
      // the statuses the UI reads, so a refresh and the registry never disagree.
      rebuildToolRegistry(lastStatuses);
      return lastStatuses;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/* ---------------------------------------------------------------------------------------------- *
 * Calling tools. Step 3 of "Planned: MCP servers as the tool and RAG providers" - the first time
 * agents reach a server's tools by name. A discovered tool starts DISABLED; a human enables it (the
 * enabled state is persisted). 8Rack keeps the approval gate, scope check, history and findings
 * ingestion (see toolManager.ts#runMcpRecord) - this module only discovers tools and makes the call.
 * ---------------------------------------------------------------------------------------------- */

/** A callable MCP tool, as the Orchestrator and toolManager see it. */
export interface McpTool {
  /** The catalog id - `<serverId>.<toolName>`, what an agent requests it by. */
  id: string;
  serverId: string;
  toolName: string;
  description: string;
  enabled: boolean;
}

/** The normalized result of an MCP tool call, shaped so toolManager can build an ExecutionResult. */
export interface McpCallResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Enable/disable state per qualified tool id - global (not mission-scoped), one small file, mirroring
 * toolManager.ts's Tool Registry overrides. */
const TOOL_OVERRIDES_FILE = path.resolve(__dirname, "../../data/mcp/tool-overrides.json");

/** The persisted enable flags, keyed by qualified id. Survives refreshes and restarts, and outlives a
 * server being briefly offline (its tools leave the registry below, but their saved flag stays). */
const enabledOverrides = new Map<string, boolean>();
/** The tools callable right now: only those from currently-online servers, rebuilt on every refresh. */
const mcpTools = new Map<string, McpTool>();

/** Rebuilds `mcpTools` from the latest statuses and stamps each status tool's `enabled` flag from the
 * persisted overrides (default disabled). Only online servers contribute callable tools. */
function rebuildToolRegistry(statuses: McpServerStatus[]): void {
  mcpTools.clear();
  for (const status of statuses) {
    if (status.state !== "online") continue;
    for (const tool of status.tools) {
      const enabled = enabledOverrides.get(tool.id) ?? false;
      tool.enabled = enabled; // the UI reads this straight off the status
      mcpTools.set(tool.id, { id: tool.id, serverId: status.id, toolName: tool.name, description: tool.description, enabled });
    }
  }
}

async function persistToolOverrides(): Promise<void> {
  const overrides: Record<string, boolean> = {};
  for (const [id, enabled] of enabledOverrides) overrides[id] = enabled;
  await mkdir(path.dirname(TOOL_OVERRIDES_FILE), { recursive: true });
  await writeFile(TOOL_OVERRIDES_FILE, `${JSON.stringify(overrides, null, 2)}\n`, "utf-8");
}

/** Loads saved enable/disable overrides. Call once at startup, before the first refresh, so the first
 * registry rebuild already reflects them. Missing file or malformed JSON are treated as "no overrides". */
export async function loadMcpToolOverridesFromDisk(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(TOOL_OVERRIDES_FILE, "utf-8");
  } catch {
    return;
  }
  let overrides: unknown;
  try {
    overrides = JSON.parse(raw);
  } catch {
    console.warn(`[mcp] ignoring malformed tool overrides file at ${TOOL_OVERRIDES_FILE}`);
    return;
  }
  if (!overrides || typeof overrides !== "object") return;
  for (const [id, enabled] of Object.entries(overrides as Record<string, unknown>)) {
    if (typeof enabled === "boolean") enabledOverrides.set(id, enabled);
  }
}

/** Every currently-callable MCP tool (from online servers), sorted by id. */
export function listMcpTools(): McpTool[] {
  return [...mcpTools.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** The callable tool with this qualified id, or undefined if no online server offers it. */
export function getMcpTool(id: string): McpTool | undefined {
  return mcpTools.get(id);
}

/** Enables or disables a discovered tool. Persisted, and reflected in the registry and the last
 * statuses so the UI updates without a full re-check. */
export async function setMcpToolEnabled(id: string, enabled: boolean): Promise<McpTool> {
  const tool = mcpTools.get(id);
  if (!tool) throw new ExecToolNotFoundError(id);
  enabledOverrides.set(id, enabled);
  tool.enabled = enabled;
  const statusTool = lastStatuses?.flatMap((s) => s.tools).find((t) => t.id === id);
  if (statusTool) statusTool.enabled = enabled;
  await persistToolOverrides();
  return tool;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

/** Reads our CommandResult-shaped structuredContent if present, else falls back to text content. A
 * server's output is untrusted, so every field is defaulted rather than assumed. */
function normalizeCallResult(raw: Record<string, unknown>): McpCallResult {
  // The SDK's result type also admits the legacy `{toolResult}` shape - read fields defensively.
  const result = raw as { isError?: unknown; content?: unknown; structuredContent?: unknown };
  if (result.isError) {
    return { success: false, stdout: "", stderr: textOf(result.content) || "The MCP tool reported an error.", exitCode: null, timedOut: false, truncated: false };
  }
  const sc = result.structuredContent;
  if (sc && typeof sc === "object") {
    const r = sc as Record<string, unknown>;
    const has = (k: string) => k in r;
    if (has("stdout") || has("exitCode") || has("success")) {
      return {
        success: r.success === true,
        stdout: typeof r.stdout === "string" ? r.stdout : "",
        stderr: typeof r.stderr === "string" ? r.stderr : "",
        exitCode: typeof r.exitCode === "number" ? r.exitCode : null,
        timedOut: r.timedOut === true,
        truncated: r.truncated === true,
      };
    }
  }
  const text = textOf(result.content);
  return { success: true, stdout: text, stderr: "", exitCode: 0, timedOut: false, truncated: false };
}

/**
 * Calls an MCP tool and returns its raw output. Connects, calls, disconnects - the same per-call
 * connection the discovery checks use. The caller (toolManager.ts, after a human has approved and
 * scope has been re-checked) owns the AbortSignal: a cancel/disconnect aborts the request, and the
 * server is then responsible for killing its process group. Throws if the server is no longer
 * configured or can't be reached, which toolManager surfaces as a failed execution.
 */
export async function callMcpTool(serverId: string, toolName: string, args: string[], signal?: AbortSignal): Promise<McpCallResult> {
  const server = configuredServers().servers.find((s) => s.id === serverId);
  if (!server) throw new Error(`MCP server "${serverId}" is no longer configured.`);

  const client = new Client({ name: "8rack", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(server.url, {
    requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
    redirectPolicy: "same-origin",
  });
  try {
    await client.connect(transport, { timeout: env.mcpRequestTimeoutMs });
    const result = await client.callTool(
      { name: toolName, arguments: { args } },
      undefined,
      { timeout: env.mcpToolTimeoutMs, signal },
    );
    return normalizeCallResult(result);
  } catch (err) {
    if (err instanceof StreamableHTTPError && (err.code === 401 || err.code === 403)) {
      throw new Error(`The MCP server "${serverId}" rejected the token (HTTP ${err.code}). Check ${tokenVariable(serverId)}.`);
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    await client.close().catch(() => {});
  }
}
