import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { env } from "../config/env.js";
import { McpRequestError } from "./errors.js";
import type { McpServerStatus, McpToolInfo } from "../types/mcp.js";

/**
 * 8Rack as an MCP client (see "Planned: MCP servers as the tool and RAG providers" in DEVELOPMENT.md):
 * connect to the servers named in `.env`, list the tools they offer, and call a tool on one.
 *
 * `callTool` has exactly one caller so far - knowledgeBase.ts, for the RAG server. Agents never reach it
 * directly: calling MCP tools from an agent needs the approval gate and enable switch (TODO.md step 3).
 *
 * Every check and call opens a connection and closes it again, rather than holding connections open:
 * calls are rare and short, and a server that restarts needs no reconnect logic.
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
  return { ...problem, knowledgeBase: problem.id === env.mcpRagServer, state: "misconfigured", tools: [], skippedTools: 0, checkedAt: null };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function describeError(err: unknown, server: McpServerConfig, timeoutMs: number): string {
  if (err instanceof StreamableHTTPError && (err.code === 401 || err.code === 403)) {
    return `The server rejected the token (HTTP ${err.code}). Check ${tokenVariable(server.id)}.`;
  }
  if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
    return `No answer within ${timeoutMs} ms`;
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

function openClient(server: McpServerConfig) {
  const client = new Client({ name: "8rack", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(server.url, {
    requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
    // The SDK's default, set here on purpose: a redirect to another origin must not carry the token.
    redirectPolicy: "same-origin",
  });
  return { client, transport };
}

async function checkServer(server: McpServerConfig): Promise<McpServerStatus> {
  const base = { id: server.id, url: server.url.href, knowledgeBase: server.id === env.mcpRagServer };
  const timeout = env.mcpRequestTimeoutMs;
  const { client, transport } = openClient(server);

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
    return { ...base, state: "error", error: describeError(err, server, timeout), tools: [], skippedTools: 0, checkedAt: Date.now() };
  } finally {
    await client.close().catch(() => {});
  }
}

function errorText(content: unknown): string {
  const text = Array.isArray(content)
    ? content
        .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join(" ")
    : "";
  return truncate(text.trim() || "The tool reported an error", MAX_ERROR_CHARS);
}

/**
 * Calls one tool on a configured server and returns its structured result. Every failure - not
 * configured, unreachable, timed out, rejected the token, or an error the tool itself reported - is an
 * McpRequestError naming the server.
 */
export async function callTool(
  serverId: string,
  name: string,
  args: Record<string, unknown>,
  timeout = env.mcpRequestTimeoutMs,
): Promise<Record<string, unknown>> {
  const { servers, problems } = configuredServers();
  const server = servers.find((s) => s.id === serverId);
  if (!server) {
    const problem = problems.find((p) => p.id === serverId);
    throw new McpRequestError(
      problem ? `MCP server "${serverId}" is misconfigured: ${problem.error}` : `MCP server "${serverId}" isn't in MCP_SERVERS`,
    );
  }

  const { client, transport } = openClient(server);
  try {
    await client.connect(transport, { timeout });
    const result = (await client.callTool({ name, arguments: args }, undefined, { timeout })) as {
      isError?: boolean;
      content?: unknown;
      structuredContent?: unknown;
    };
    if (result.isError) throw new McpRequestError(`MCP server "${serverId}": ${errorText(result.content)}`);
    const structured = result.structuredContent;
    if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
      throw new McpRequestError(`MCP server "${serverId}" returned no structured result from ${name}`);
    }
    return structured as Record<string, unknown>;
  } catch (err) {
    if (err instanceof McpRequestError) throw err;
    throw new McpRequestError(`MCP server "${serverId}": ${describeError(err, server, timeout)}`);
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
    ...servers.map(
      (s): McpServerStatus => ({
        id: s.id,
        url: s.url.href,
        knowledgeBase: s.id === env.mcpRagServer,
        state: "checking",
        tools: [],
        skippedTools: 0,
        checkedAt: null,
      }),
    ),
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
