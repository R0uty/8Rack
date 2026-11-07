import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { env } from "../config/env.js";
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

/** Keeps only tools with an accepted name, once each, up to the cap. */
function acceptedTools(offered: { name: string; description?: string }[]): McpToolInfo[] {
  const tools: McpToolInfo[] = [];
  const names = new Set<string>();
  for (const tool of offered) {
    if (tools.length >= MAX_TOOLS_PER_SERVER) break;
    if (!TOOL_NAME.test(tool.name) || names.has(tool.name)) continue;
    names.add(tool.name);
    tools.push({ name: tool.name, description: truncate((tool.description ?? "").trim(), MAX_DESCRIPTION_CHARS) });
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
    const tools = acceptedTools(offered);
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
      return lastStatuses;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
