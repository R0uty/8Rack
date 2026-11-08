import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { env } from "../config/env.js";
import { McpRequestError } from "./errors.js";
import * as local from "./ragIndex.js";
import { getStatus, refreshStatus, reindex, search } from "./knowledgeBase.js";

vi.mock("./ragIndex.js", () => ({ getStatus: vi.fn(), reindex: vi.fn(), search: vi.fn() }));

const TOKEN = "test-token-not-a-real-secret";

const STATUS = {
  indexedAt: 1_700_000_000_000,
  fileCount: 2,
  chunkCount: 3,
  embeddingModel: "nomic-embed-text",
  workspaceRoot: "/srv/review",
};

const RESULT = { filePath: "src/auth.ts", startLine: 1, endLine: 50, text: "function login() {}", score: 0.9 };

/** What the fake RAG server answers for each tool - replaced per test. */
let answers: Record<string, () => { structuredContent?: unknown; isError?: boolean; text?: string }>;
const calls: { name: string; args: unknown }[] = [];

let httpServer: http.Server;
let url: URL;

/** A real MCP server from the same SDK, standing in for mcp-servers/rag/ (whose own tests are in
 * Python). It checks the bearer token like the real one. */
beforeAll(async () => {
  httpServer = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    const server = new Server({ name: "rag", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: ["search", "reindex", "status"].map((name) => ({ name, inputSchema: { type: "object" as const } })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      calls.push({ name: request.params.name, args: request.params.arguments });
      const answer = answers[request.params.name]?.() ?? { isError: true, text: "Unknown tool" };
      return {
        content: [{ type: "text" as const, text: answer.text ?? JSON.stringify(answer.structuredContent) }],
        ...(answer.structuredContent !== undefined ? { structuredContent: answer.structuredContent } : {}),
        ...(answer.isError ? { isError: true } : {}),
      } as never;
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  url = new URL(`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`);
});

afterAll(
  () =>
    new Promise<void>((resolve) => {
      httpServer.closeAllConnections();
      httpServer.close(() => resolve());
    }),
);

const original = { mcpServers: env.mcpServers, mcpRagServer: env.mcpRagServer, token: process.env.MCP_TOKEN_RAG };

function useServer(token = TOKEN) {
  env.mcpServers = `rag=${url.href}`;
  env.mcpRagServer = "rag";
  process.env.MCP_TOKEN_RAG = token;
}

beforeEach(() => {
  calls.length = 0;
  answers = {
    status: () => ({ structuredContent: STATUS }),
    reindex: () => ({ structuredContent: { ...STATUS, chunkCount: 4 } }),
    search: () => ({ structuredContent: { results: [RESULT] } }),
  };
});

afterEach(() => {
  env.mcpServers = original.mcpServers;
  env.mcpRagServer = original.mcpRagServer;
  if (original.token === undefined) delete process.env.MCP_TOKEN_RAG;
  else process.env.MCP_TOKEN_RAG = original.token;
  vi.mocked(local.getStatus).mockReset();
  vi.mocked(local.search).mockReset();
  vi.mocked(local.reindex).mockReset();
});

describe("without MCP_RAG_SERVER", () => {
  it("uses the local index for everything", async () => {
    env.mcpRagServer = undefined;
    vi.mocked(local.getStatus).mockReturnValue(STATUS);
    vi.mocked(local.search).mockResolvedValue([RESULT]);
    vi.mocked(local.reindex).mockResolvedValue(STATUS);

    expect(getStatus()).toEqual(STATUS);
    expect(await refreshStatus()).toEqual(STATUS);
    expect(await search("login", 3)).toEqual([RESULT]);
    expect(await reindex()).toEqual(STATUS);
    expect(local.search).toHaveBeenCalledWith("login", 3);
    expect(calls).toEqual([]);
  });
});

describe("with MCP_RAG_SERVER", () => {
  // Runs first: the cached status is module state that the later tests fill in.
  it("reports nothing indexed until the server has answered once", () => {
    useServer();
    expect(getStatus()).toMatchObject({ chunkCount: 0, indexedAt: null, server: "rag" });
    expect(local.getStatus).not.toHaveBeenCalled();
  });

  it("asks the server for status and keeps the answer for getStatus", async () => {
    useServer();
    expect(await refreshStatus()).toEqual({ ...STATUS, server: "rag" });
    expect(getStatus()).toEqual({ ...STATUS, server: "rag" });
  });

  it("reindexes on the server and keeps the new status", async () => {
    useServer();
    expect((await reindex()).chunkCount).toBe(4);
    expect(getStatus().chunkCount).toBe(4);
    expect(local.reindex).not.toHaveBeenCalled();
  });

  it("searches on the server, passing the query and how many results to return", async () => {
    useServer();
    expect(await search("how is login handled", 3)).toEqual([RESULT]);
    expect(calls).toEqual([{ name: "search", args: { query: "how is login handled", top_k: 3 } }]);
  });

  it("never returns more results than asked for", async () => {
    useServer();
    answers.search = () => ({ structuredContent: { results: [RESULT, RESULT, RESULT] } });
    expect(await search("login", 2)).toHaveLength(2);
  });

  it("rejects a malformed answer instead of passing it on", async () => {
    useServer();
    answers.search = () => ({ structuredContent: { results: [{ filePath: "a.ts" }] } });
    answers.status = () => ({ structuredContent: { chunkCount: "lots" } });

    await expect(search("login")).rejects.toThrow('MCP server "rag" returned an invalid search result');
    await expect(refreshStatus()).rejects.toThrow('MCP server "rag" returned an invalid status');
  });

  it("passes on the error the tool reported", async () => {
    useServer();
    answers.reindex = () => ({ isError: true, text: "Can't reach Ollama at http://127.0.0.1:11434 (Connection refused)" });
    await expect(reindex()).rejects.toThrow(
      new McpRequestError(`MCP server "rag": Can't reach Ollama at http://127.0.0.1:11434 (Connection refused)`),
    );
  });

  it("says when the server rejects the token, without showing it", async () => {
    useServer("wrong-token-value-here");
    const err = await search("login").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpRequestError);
    expect((err as Error).message).toContain("rejected the token (HTTP 401). Check MCP_TOKEN_RAG");
    expect((err as Error).message).not.toContain("wrong-token-value-here");
  });

  it("says when MCP_RAG_SERVER names a server that isn't configured", async () => {
    useServer();
    env.mcpRagServer = "knowledge";
    await expect(search("login")).rejects.toThrow(`MCP server "knowledge" isn't in MCP_SERVERS`);
  });

  it("says when the named server is misconfigured", async () => {
    useServer();
    delete process.env.MCP_TOKEN_RAG;
    await expect(refreshStatus()).rejects.toThrow(/MCP server "rag" is misconfigured: .*MCP_TOKEN_RAG/);
  });

  it("doesn't fall back to the local index when the server is down", async () => {
    useServer();
    env.mcpServers = "rag=http://127.0.0.1:1/mcp";
    await expect(search("login")).rejects.toBeInstanceOf(McpRequestError);
    expect(local.search).not.toHaveBeenCalled();
  });
});
