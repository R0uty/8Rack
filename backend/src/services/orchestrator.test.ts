import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgent } from "./agentManager.js";
import { streamAgentChat } from "./chatService.js";
import { cancelExecution, getExecution, listExecTools, rejectExecution, requestExecution } from "./toolManager.js";
import { env } from "../config/env.js";
import {
  AgentNotFoundError,
  InvalidTaskStateError,
  RequestCancelledError,
  TaskNotFoundError,
} from "./errors.js";
import {
  cancelTask,
  continueTask,
  createTask,
  listTasks,
  parseToolRequest,
  provideGuidance,
  resumeTask,
} from "./orchestrator.js";
import { getStatus as getRagStatus, search as searchKnowledgeBase } from "./ragIndex.js";
import { createFinding, getProjectFindings } from "./findingsManager.js";
import { queryNvd } from "./cveLookup.js";
import { getProject } from "./projectManager.js";
import type { AgentWithStatus } from "../types/agent.js";
import type { ChatResponseChunk } from "../types/ollama.js";
import type { ExecTool, ExecutionRecord } from "../types/execTool.js";
import type { RagIndexStatus } from "../types/rag.js";

vi.mock("./agentManager.js", () => ({ getAgent: vi.fn() }));
vi.mock("./chatService.js", () => ({ streamAgentChat: vi.fn() }));
vi.mock("./toolManager.js", () => ({
  requestExecution: vi.fn(),
  getExecution: vi.fn(),
  cancelExecution: vi.fn(),
  rejectExecution: vi.fn(),
  listExecTools: vi.fn(() => []),
}));
vi.mock("./projectStore.js", () => ({
  listProjectIds: vi.fn(async () => []),
  readProjectJson: vi.fn(async () => []),
  writeProjectJson: vi.fn(async () => undefined),
}));
vi.mock("./projectManager.js", () => ({ getProject: vi.fn(async () => undefined) }));
vi.mock("./ragIndex.js", () => ({ getStatus: vi.fn(), search: vi.fn() }));
vi.mock("./cveLookup.js", () => ({ queryNvd: vi.fn() }));

const mockGetAgent = vi.mocked(getAgent);
const mockStreamAgentChat = vi.mocked(streamAgentChat);
const mockRequestExecution = vi.mocked(requestExecution);
const mockListExecTools = vi.mocked(listExecTools);
const mockGetExecution = vi.mocked(getExecution);
const mockCancelExecution = vi.mocked(cancelExecution);
const mockRejectExecution = vi.mocked(rejectExecution);
const mockGetRagStatus = vi.mocked(getRagStatus);
const mockSearchKnowledgeBase = vi.mocked(searchKnowledgeBase);
const mockGetProject = vi.mocked(getProject);
const mockQueryNvd = vi.mocked(queryNvd);

const fixtureAgent: AgentWithStatus = {
  id: "test-agent",
  name: "Test Agent",
  description: "",
  model: "test-model",
  systemPrompt: "You are a test agent.",
  temperature: 0.5,
  topP: 0.9,
  maxTokens: 0,
  icon: "",
  color: "",
  enabled: true,
  status: "online",
};

/** Builds a mock streamAgentChat implementation that yields a single assistant chunk per call,
 * cycling through `replies` in order (last reply repeats if the generator is called more times). */
function repliesGenerator(replies: string[]) {
  let call = 0;
  return async function* (): AsyncGenerator<ChatResponseChunk> {
    const content = replies[Math.min(call, replies.length - 1)];
    call++;
    yield { model: "test-model", created_at: "", message: { role: "assistant", content }, done: true };
  };
}

function fixtureExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: randomUUID(),
    projectId: "proj-1",
    toolId: "bash",
    arguments: ["-c", "echo hi"],
    resolvedCommand: "bash -c 'echo hi'",
    cwd: "/tmp",
    status: "completed",
    createdAt: Date.now(),
    result: {
      stdout: "hi\n",
      stderr: "",
      exitCode: 0,
      executionTimeMs: 5,
      success: true,
      timedOut: false,
      cancelled: false,
      truncated: false,
    },
    ...overrides,
  };
}

function fixtureExecTool(overrides: Partial<ExecTool> = {}): ExecTool {
  return {
    id: "dig",
    name: "Dig",
    description: "Queries DNS records for a domain.",
    category: "recon",
    executable: "dig",
    defaultArguments: [],
    timeout: 10_000,
    enabled: true,
    requiresConfirmation: true,
    parser: "text",
    icon: "",
    ...overrides,
  };
}

const emptyRagStatus: RagIndexStatus = {
  indexedAt: null,
  fileCount: 0,
  chunkCount: 0,
  embeddingModel: "test-embed-model",
  workspaceRoot: "/workspace",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAgent.mockResolvedValue(fixtureAgent);
  // buildToolsPreamble() calls getRagStatus() on every agent call - default to "not indexed" so
  // existing (non-RAG) tests aren't affected; RAG-specific tests below override this themselves.
  mockGetRagStatus.mockReturnValue(emptyRagStatus);
  // clearAllMocks() doesn't undo a mockReturnValue set by an earlier test, so re-pin the default
  // here too - the allowlist-filtering tests below override this per-test.
  mockListExecTools.mockReturnValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("parseToolRequest", () => {
  it("parses a strict JSON tool request", () => {
    expect(parseToolRequest('{"tool": "bash", "arguments": ["-c", "ls"]}')).toEqual({
      tool: "bash",
      arguments: ["-c", "ls"],
    });
  });

  it("parses a fenced ```json block", () => {
    expect(parseToolRequest('```json\n{"tool": "dig", "arguments": ["example.com"]}\n```')).toEqual({
      tool: "dig",
      arguments: ["example.com"],
    });
  });

  it("extracts JSON surrounded by prose", () => {
    expect(
      parseToolRequest('Sure, here you go: {"tool": "whois", "arguments": ["example.com"]} - let me know!'),
    ).toEqual({ tool: "whois", arguments: ["example.com"] });
  });

  it("returns undefined for plain text", () => {
    expect(parseToolRequest("The answer is 42.")).toBeUndefined();
  });

  it("returns undefined for JSON that isn't a tool-request shape", () => {
    expect(parseToolRequest('{"foo": "bar"}')).toBeUndefined();
  });
});

describe("createTask", () => {
  it("throws AgentNotFoundError for an unknown agent", async () => {
    mockGetAgent.mockResolvedValue(undefined);
    await expect(createTask("nope", "objective", "proj-1")).rejects.toThrow(AgentNotFoundError);
  });

  it("completes immediately on a plain-text reply", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(["The answer is 42."]));

    const task = await createTask("test-agent", "What is the answer?", "proj-1");

    expect(task.status).toBe("completed");
    expect(task.finalResponse).toBe("The answer is 42.");
    expect(mockRequestExecution).not.toHaveBeenCalled();
  });

  it("passes a model override through to every streamAgentChat call and stores it on the task", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(["hi"]));

    const task = await createTask("test-agent", "objective", "proj-1", undefined, undefined, "override-model");

    expect(task.model).toBe("override-model");
    expect(mockStreamAgentChat).toHaveBeenCalledWith(
      expect.objectContaining({ model: "override-model" }),
      undefined,
    );
  });

  it("omits model (falls back to the agent's own) when no override is given", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(["hi"]));

    const task = await createTask("test-agent", "objective", "proj-1");

    expect(task.model).toBeUndefined();
    expect(mockStreamAgentChat).toHaveBeenCalledWith(expect.objectContaining({ model: undefined }), undefined);
  });

  it("requests the tool and lands on waiting_confirmation for a valid tool request", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "bash", "arguments": ["-c", "ls"]}']));
    const record = fixtureExecution({ projectId: "proj-1" });
    mockRequestExecution.mockResolvedValue(record);

    const task = await createTask("test-agent", "List files", "proj-1");

    expect(mockRequestExecution).toHaveBeenCalledWith({
      tool: "bash",
      arguments: ["-c", "ls"],
      projectId: "proj-1",
      agentId: "test-agent",
    });
    expect(task.status).toBe("waiting_confirmation");
    expect(task.pendingExecutionId).toBe(record.id);
    expect(task.toolExecutionIds).toContain(record.id);
    expect(task.toolCallCount).toBe(1);
  });

  it("pauses at waiting_guidance (not an automatic retry) when the tool request is invalid", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "nope", "arguments": []}']));
    mockRequestExecution.mockRejectedValueOnce(new Error("Unknown tool"));

    const task = await createTask("test-agent", "objective", "proj-1");

    // Used to recurse and retry automatically with zero human visibility - now it stops and waits,
    // so streamAgentChat is called exactly once, not twice.
    expect(task.status).toBe("waiting_guidance");
    expect(task.toolCallCount).toBe(1);
    expect(task.pendingExecutionId).toBeUndefined();
    expect(task.messages.some((m) => m.role === "tool" && m.content.includes("Unknown tool"))).toBe(true);
    expect(mockStreamAgentChat).toHaveBeenCalledTimes(1);
  });

  it("only lists an agent's allowed exec tools in the tools preamble when execTools is set", async () => {
    mockListExecTools.mockReturnValue([
      fixtureExecTool({ id: "dig", name: "Dig" }),
      fixtureExecTool({ id: "nmap", name: "Nmap" }),
    ]);
    mockGetAgent.mockResolvedValue({ ...fixtureAgent, execTools: ["dig"] });
    mockStreamAgentChat.mockImplementation(repliesGenerator(["no tool needed"]));

    await createTask("test-agent", "objective", "proj-1");

    const [[request]] = mockStreamAgentChat.mock.calls;
    expect(request.toolsPreamble).toContain("dig");
    expect(request.toolsPreamble).not.toContain("nmap");
  });

  it("lists every enabled exec tool when execTools is unset (unrestricted)", async () => {
    mockListExecTools.mockReturnValue([fixtureExecTool({ id: "dig" }), fixtureExecTool({ id: "nmap" })]);
    mockStreamAgentChat.mockImplementation(repliesGenerator(["no tool needed"]));

    await createTask("test-agent", "objective", "proj-1");

    const [[request]] = mockStreamAgentChat.mock.calls;
    expect(request.toolsPreamble).toContain("dig");
    expect(request.toolsPreamble).toContain("nmap");
  });

  it("prepends mission context to the tools preamble when the project has scope/rules/etc configured", async () => {
    mockListExecTools.mockReturnValue([fixtureExecTool({ id: "dig" })]);
    mockGetProject.mockResolvedValueOnce({
      id: "proj-1",
      name: "Acme Pentest",
      notes: "",
      createdAt: 0,
      description: "External web app assessment",
      scope: ["example.com", "*.example.com"],
      outOfScope: ["staging.example.com"],
      rules: "No automated DoS testing",
      status: "active",
    });
    mockStreamAgentChat.mockImplementation(repliesGenerator(["no tool needed"]));

    await createTask("test-agent", "objective", "proj-1");

    const [[request]] = mockStreamAgentChat.mock.calls;
    expect(request.toolsPreamble).toContain("Mission: Acme Pentest (status: active)");
    expect(request.toolsPreamble).toContain("Description: External web app assessment");
    expect(request.toolsPreamble).toContain("Scope (authorized targets): example.com, *.example.com");
    expect(request.toolsPreamble).toContain("Out of scope (never target these): staging.example.com");
    expect(request.toolsPreamble).toContain("Rules of engagement: No automated DoS testing");
  });

  it("omits mission context entirely for a project with no mission fields set", async () => {
    mockListExecTools.mockReturnValue([fixtureExecTool({ id: "dig" })]);
    mockGetProject.mockResolvedValueOnce({ id: "proj-1", name: "Plain Project", notes: "", createdAt: 0 });
    mockStreamAgentChat.mockImplementation(repliesGenerator(["no tool needed"]));

    await createTask("test-agent", "objective", "proj-1");

    const [[request]] = mockStreamAgentChat.mock.calls;
    expect(request.toolsPreamble).not.toContain("Mission:");
  });

  it("never crashes tool-calling if the project lookup for mission context fails", async () => {
    mockListExecTools.mockReturnValue([fixtureExecTool({ id: "dig" })]);
    mockGetProject.mockRejectedValueOnce(new Error("disk error"));
    mockStreamAgentChat.mockImplementation(repliesGenerator(["no tool needed"]));

    const task = await createTask("test-agent", "objective", "proj-1");
    expect(task.status).toBe("completed");
  });

  it("rejects a tool request outside the agent's execTools allowlist without executing it", async () => {
    mockGetAgent.mockResolvedValue({ ...fixtureAgent, execTools: ["dig"] });
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "nmap", "arguments": ["-sV", "example.com"]}']));

    const task = await createTask("test-agent", "objective", "proj-1");

    expect(mockRequestExecution).not.toHaveBeenCalled();
    expect(task.status).toBe("waiting_guidance");
    expect(task.toolCallCount).toBe(1);
    expect(task.pendingExecutionId).toBeUndefined();
    expect(task.messages.some((m) => m.role === "tool" && m.content.includes("not permitted"))).toBe(true);
  });

  it("allows a tool request that is in the agent's execTools allowlist", async () => {
    mockGetAgent.mockResolvedValue({ ...fixtureAgent, execTools: ["dig"] });
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "dig", "arguments": ["example.com"]}']));
    const record = fixtureExecution({ toolId: "dig" });
    mockRequestExecution.mockResolvedValueOnce(record);

    const task = await createTask("test-agent", "objective", "proj-1");

    expect(mockRequestExecution).toHaveBeenCalledWith({
      tool: "dig",
      arguments: ["example.com"],
      projectId: "proj-1",
      agentId: "test-agent",
    });
    expect(task.status).toBe("waiting_confirmation");
  });

  it("marks the task cancelled and rethrows on RequestCancelledError", async () => {
    mockStreamAgentChat.mockImplementation(async function* () {
      throw new RequestCancelledError();
      // eslint-disable-next-line no-unreachable
      yield undefined as never;
    });

    await expect(createTask("test-agent", "objective", "proj-cancel")).rejects.toThrow(RequestCancelledError);

    const [task] = listTasks("proj-cancel");
    expect(task.status).toBe("cancelled");
  });

  it("marks the task failed when the agent call throws a non-cancellation error", async () => {
    mockStreamAgentChat.mockImplementation(async function* () {
      throw new Error("model exploded");
      // eslint-disable-next-line no-unreachable
      yield undefined as never;
    });

    const task = await createTask("test-agent", "objective", "proj-fail");

    expect(task.status).toBe("failed");
    expect(task.error).toBe("model exploded");
  });
});

describe("search_knowledge_base tool", () => {
  const indexedRagStatus: RagIndexStatus = {
    indexedAt: Date.now(),
    fileCount: 3,
    chunkCount: 12,
    embeddingModel: "test-embed-model",
    workspaceRoot: "/workspace",
  };

  it("skips confirmation entirely - never touches requestExecution or waiting_confirmation", async () => {
    mockGetRagStatus.mockReturnValue(indexedRagStatus);
    mockSearchKnowledgeBase.mockResolvedValue([
      { filePath: "auth.ts", startLine: 1, endLine: 10, text: "function login() {}", score: 0.9 },
    ]);
    mockStreamAgentChat.mockImplementation(
      repliesGenerator([
        '{"tool": "search_knowledge_base", "arguments": ["how does login work"]}',
        "Login is handled by the login() function.",
      ]),
    );

    const task = await createTask("test-agent", "How does auth work?", "proj-rag-1");

    expect(mockSearchKnowledgeBase).toHaveBeenCalledWith("how does login work");
    expect(mockRequestExecution).not.toHaveBeenCalled();
    expect(task.status).toBe("completed");
    expect(task.finalResponse).toBe("Login is handled by the login() function.");

    const toolMessage = task.messages.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    const parsed = JSON.parse(toolMessage!.content);
    expect(parsed).toMatchObject({ tool: "search_knowledge_base", success: true });
    expect(parsed.stdout).toContain("auth.ts:1-10");
  });

  it("still counts against the tool-call cap", async () => {
    mockGetRagStatus.mockReturnValue(indexedRagStatus);
    mockSearchKnowledgeBase.mockResolvedValue([]);
    mockStreamAgentChat.mockImplementation(async function* () {
      yield {
        model: "test-model",
        created_at: "",
        message: { role: "assistant", content: '{"tool": "search_knowledge_base", "arguments": ["x"]}' },
        done: true,
      };
    });

    const task = await createTask("test-agent", "objective", "proj-rag-2");

    expect(task.status).toBe("max_executions_reached");
    expect(task.toolCallCount).toBe(env.maxOrchestratorToolCalls);
  });

  it("reports failure and recovers gracefully when the index is empty", async () => {
    mockGetRagStatus.mockReturnValue(emptyRagStatus);
    mockStreamAgentChat.mockImplementation(
      repliesGenerator([
        '{"tool": "search_knowledge_base", "arguments": ["anything"]}',
        "Understood, I'll answer without codebase context.",
      ]),
    );

    const task = await createTask("test-agent", "objective", "proj-rag-3");

    expect(mockSearchKnowledgeBase).not.toHaveBeenCalled();
    expect(task.status).toBe("completed");
    const toolMessage = task.messages.find((m) => m.role === "tool");
    expect(JSON.parse(toolMessage!.content)).toMatchObject({ success: false });
  });

  it("reports failure and recovers gracefully when the search call itself throws", async () => {
    mockGetRagStatus.mockReturnValue(indexedRagStatus);
    mockSearchKnowledgeBase.mockRejectedValue(new Error("embedding model unavailable"));
    mockStreamAgentChat.mockImplementation(
      repliesGenerator([
        '{"tool": "search_knowledge_base", "arguments": ["anything"]}',
        "Falling back to a plain answer.",
      ]),
    );

    const task = await createTask("test-agent", "objective", "proj-rag-4");

    expect(task.status).toBe("completed");
    const toolMessage = task.messages.find((m) => m.role === "tool");
    const parsed = JSON.parse(toolMessage!.content);
    expect(parsed.success).toBe(false);
    expect(parsed.message).toContain("embedding model unavailable");
  });
});

describe("query_findings tool", () => {
  it("skips confirmation entirely and returns matching findings", async () => {
    const projectId = "proj-findings-1";
    await createFinding(projectId, {
      type: "port",
      severity: "info",
      title: "Port 80/tcp open",
      description: "d",
      target: "example.com",
      value: "80/tcp",
    });
    mockStreamAgentChat.mockImplementation(
      repliesGenerator(['{"tool": "query_findings", "arguments": []}', "There is one open port."]),
    );

    const task = await createTask("test-agent", "What's known?", projectId);

    expect(mockRequestExecution).not.toHaveBeenCalled();
    expect(task.status).toBe("completed");
    const toolMessage = task.messages.find((m) => m.role === "tool");
    const parsed = JSON.parse(toolMessage!.content);
    expect(parsed).toMatchObject({ tool: "query_findings", success: true });
    expect(parsed.stdout).toContain("Port 80/tcp open");
  });

  it("filters by type when a type argument is given", async () => {
    const projectId = "proj-findings-2";
    await createFinding(projectId, {
      type: "port",
      severity: "info",
      title: "Port A",
      description: "d",
      target: "t",
      value: "80/tcp",
    });
    await createFinding(projectId, {
      type: "technology",
      severity: "info",
      title: "nginx",
      description: "d",
      target: "t",
      value: "nginx",
    });
    mockStreamAgentChat.mockImplementation(
      repliesGenerator(['{"tool": "query_findings", "arguments": ["technology"]}', "ok"]),
    );

    const task = await createTask("test-agent", "objective", projectId);
    const toolMessage = task.messages.find((m) => m.role === "tool");
    const parsed = JSON.parse(toolMessage!.content);
    expect(parsed.parsedOutput).toHaveLength(1);
    expect(parsed.parsedOutput[0].type).toBe("technology");
  });

  it("still counts against the tool-call cap", async () => {
    mockStreamAgentChat.mockImplementation(async function* () {
      yield {
        model: "test-model",
        created_at: "",
        message: { role: "assistant", content: '{"tool": "query_findings", "arguments": []}' },
        done: true,
      };
    });

    const task = await createTask("test-agent", "objective", "proj-findings-cap");

    expect(task.status).toBe("max_executions_reached");
    expect(task.toolCallCount).toBe(env.maxOrchestratorToolCalls);
  });

  it("reports failure without crashing for an unrecognized type filter", async () => {
    const projectId = "proj-findings-3";
    await createFinding(projectId, {
      type: "port",
      severity: "info",
      title: "p",
      description: "d",
      target: "t",
      value: "80/tcp",
    });
    mockStreamAgentChat.mockImplementation(
      repliesGenerator(['{"tool": "query_findings", "arguments": ["not-a-type"]}', "ok"]),
    );

    const task = await createTask("test-agent", "objective", projectId);
    const toolMessage = task.messages.find((m) => m.role === "tool");
    expect(JSON.parse(toolMessage!.content).success).toBe(false);
  });
});

describe("lookup_cves tool", () => {
  it("skips confirmation entirely and creates a linked cve finding", async () => {
    const projectId = "proj-cve-1";
    await createFinding(projectId, {
      type: "technology",
      severity: "info",
      title: "nginx",
      description: "d",
      target: "example.com",
      value: "nginx",
    });
    mockQueryNvd.mockResolvedValue([
      { id: "CVE-2021-1234", description: "d", cvssScore: 9.8, cvssSeverity: "critical", cvssVector: null, references: [] },
    ]);
    mockStreamAgentChat.mockImplementation(
      repliesGenerator(['{"tool": "lookup_cves", "arguments": ["nginx"]}', "Found a critical CVE."]),
    );

    const task = await createTask("test-agent", "Check nginx for CVEs", projectId);

    expect(mockQueryNvd).toHaveBeenCalledWith("nginx");
    expect(mockRequestExecution).not.toHaveBeenCalled();
    expect(task.status).toBe("completed");

    const toolMessage = task.messages.find((m) => m.role === "tool");
    const parsed = JSON.parse(toolMessage!.content);
    expect(parsed).toMatchObject({ tool: "lookup_cves", success: true });
    expect(parsed.stdout).toContain("CVE-2021-1234");
    // Best-effort linked to the existing "nginx" technology finding's target, not "unknown".
    expect(parsed.parsedOutput[0].target).toBe("example.com");
  });

  it("falls back to target 'unknown' when no matching technology finding exists", async () => {
    const projectId = "proj-cve-2";
    mockQueryNvd.mockResolvedValue([
      { id: "CVE-2021-5678", description: "d", cvssScore: 5.0, cvssSeverity: "medium", cvssVector: null, references: [] },
    ]);
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "lookup_cves", "arguments": ["apache"]}', "ok"]));

    const task = await createTask("test-agent", "objective", projectId);
    const toolMessage = task.messages.find((m) => m.role === "tool");
    const parsed = JSON.parse(toolMessage!.content);
    expect(parsed.parsedOutput[0].target).toBe("unknown");
  });

  it("still counts against the tool-call cap", async () => {
    mockQueryNvd.mockResolvedValue([]);
    mockStreamAgentChat.mockImplementation(async function* () {
      yield {
        model: "test-model",
        created_at: "",
        message: { role: "assistant", content: '{"tool": "lookup_cves", "arguments": ["nginx"]}' },
        done: true,
      };
    });

    const task = await createTask("test-agent", "objective", "proj-cve-cap");

    expect(task.status).toBe("max_executions_reached");
    expect(task.toolCallCount).toBe(env.maxOrchestratorToolCalls);
  });

  it("reports failure without crashing when no product name argument is given", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "lookup_cves", "arguments": []}', "ok"]));

    const task = await createTask("test-agent", "objective", "proj-cve-3");
    const toolMessage = task.messages.find((m) => m.role === "tool");
    expect(JSON.parse(toolMessage!.content).success).toBe(false);
  });

  it("reports failure and recovers gracefully when the NVD lookup itself throws", async () => {
    mockQueryNvd.mockRejectedValue(new Error("NVD API rate limit exceeded"));
    mockStreamAgentChat.mockImplementation(
      repliesGenerator(['{"tool": "lookup_cves", "arguments": ["nginx"]}', "Falling back to a plain answer."]),
    );

    const task = await createTask("test-agent", "objective", "proj-cve-4");

    expect(task.status).toBe("completed");
    const toolMessage = task.messages.find((m) => m.role === "tool");
    const parsed = JSON.parse(toolMessage!.content);
    expect(parsed.success).toBe(false);
    expect(parsed.message).toContain("rate limit");
  });
});

describe("create_finding tool", () => {
  const validPayload = JSON.stringify({
    type: "potential_vulnerability",
    severity: "high",
    title: "Reflected XSS in search",
    description: "The q parameter is reflected unescaped.",
    target: "example.com",
    value: "/search?q",
    parameter: "q",
    impact: "Session hijack via stolen cookies",
    reproductionSteps: "1. Send a crafted q value\n2. Observe it reflected unescaped",
    evidence: "raw HTTP exchange",
  });

  it("is always listed in the preamble, with no precondition", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(["no tool needed"]));
    await createTask("test-agent", "objective", "proj-create-finding-preamble");
    const [[request]] = mockStreamAgentChat.mock.calls;
    expect(request.toolsPreamble).toContain("create_finding");
  });

  it("skips confirmation entirely and records a real finding with source 'agent'", async () => {
    const projectId = "proj-create-finding-1";
    mockStreamAgentChat.mockImplementation(
      repliesGenerator([`{"tool": "create_finding", "arguments": [${JSON.stringify(validPayload)}]}`, "Recorded."]),
    );

    const task = await createTask("recon-agent", "find bugs", projectId);

    expect(mockRequestExecution).not.toHaveBeenCalled();
    expect(task.status).toBe("completed");
    const toolMessage = task.messages.find((m) => m.role === "tool");
    const parsed = JSON.parse(toolMessage!.content);
    expect(parsed).toMatchObject({ tool: "create_finding", success: true });

    const [finding] = getProjectFindings(projectId);
    expect(finding).toMatchObject({
      type: "potential_vulnerability",
      severity: "high",
      title: "Reflected XSS in search",
      source: "agent",
      tool: "recon-agent",
      parameter: "q",
      impact: "Session hijack via stolen cookies",
    });
    expect(finding.relatedAgents).toEqual(["recon-agent"]);
    expect(finding.evidence).toEqual([{ type: "agent_reasoning", content: "raw HTTP exchange", createdAt: expect.any(Number) }]);
  });

  it("reports a validation error and recovers instead of crashing on malformed JSON", async () => {
    mockStreamAgentChat.mockImplementation(
      repliesGenerator(['{"tool": "create_finding", "arguments": ["not json"]}', "ok"]),
    );

    const task = await createTask("test-agent", "objective", "proj-create-finding-2");

    expect(task.status).toBe("completed");
    const toolMessage = task.messages.find((m) => m.role === "tool");
    const parsed = JSON.parse(toolMessage!.content);
    expect(parsed.success).toBe(false);
    expect(parsed.message).toContain("not valid JSON");
  });

  it("rejects an attempt to create a 'confirmed_vulnerability' directly", async () => {
    const badPayload = JSON.stringify({
      type: "confirmed_vulnerability",
      severity: "high",
      title: "x",
      description: "d",
      target: "t",
      value: "v",
    });
    mockStreamAgentChat.mockImplementation(
      repliesGenerator([`{"tool": "create_finding", "arguments": [${JSON.stringify(badPayload)}]}`, "ok"]),
    );

    const task = await createTask("test-agent", "objective", "proj-create-finding-3");
    const toolMessage = task.messages.find((m) => m.role === "tool");
    const parsed = JSON.parse(toolMessage!.content);
    expect(parsed.success).toBe(false);
    expect(parsed.message).toContain("confirmed_vulnerability");
    expect(getProjectFindings("proj-create-finding-3")).toHaveLength(0);
  });

  it("still counts against the tool-call cap", async () => {
    mockStreamAgentChat.mockImplementation(async function* () {
      yield {
        model: "test-model",
        created_at: "",
        message: { role: "assistant", content: `{"tool": "create_finding", "arguments": [${JSON.stringify(validPayload)}]}` },
        done: true,
      };
    });

    const task = await createTask("test-agent", "objective", "proj-create-finding-cap");

    expect(task.status).toBe("max_executions_reached");
    expect(task.toolCallCount).toBe(env.maxOrchestratorToolCalls);
  });
});

describe("resumeTask", () => {
  it("throws TaskNotFoundError for an unknown id", async () => {
    await expect(resumeTask("nope")).rejects.toThrow(TaskNotFoundError);
  });

  it("throws InvalidTaskStateError when the task isn't waiting on a confirmation", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(["done"]));
    const task = await createTask("test-agent", "objective", "proj-2");

    await expect(resumeTask(task.id)).rejects.toThrow(InvalidTaskStateError);
  });

  it("keeps using the task's model override on a resumed step", async () => {
    mockStreamAgentChat.mockImplementation(
      repliesGenerator(['{"tool": "bash", "arguments": []}', "Done."]),
    );
    const record = fixtureExecution({ status: "pending_confirmation" });
    mockRequestExecution.mockResolvedValue(record);
    const task = await createTask("test-agent", "objective", "proj-2", undefined, undefined, "override-model");

    mockGetExecution.mockReturnValue({ ...record, status: "completed" });
    await resumeTask(task.id);

    const lastCall = mockStreamAgentChat.mock.calls.at(-1);
    expect(lastCall?.[0]).toEqual(expect.objectContaining({ model: "override-model" }));
  });

  it("throws InvalidTaskStateError when the pending execution is still pending/running", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "bash", "arguments": []}']));
    const record = fixtureExecution({ status: "pending_confirmation" });
    mockRequestExecution.mockResolvedValue(record);
    const task = await createTask("test-agent", "objective", "proj-3");

    mockGetExecution.mockReturnValue(record);
    await expect(resumeTask(task.id)).rejects.toThrow(InvalidTaskStateError);
  });

  it("feeds a rejected execution back as {rejected:true} and continues", async () => {
    mockStreamAgentChat.mockImplementation(
      repliesGenerator(['{"tool": "bash", "arguments": []}', "Understood, skipping that."]),
    );
    const record = fixtureExecution({ status: "pending_confirmation" });
    mockRequestExecution.mockResolvedValue(record);
    const task = await createTask("test-agent", "objective", "proj-4");

    mockGetExecution.mockReturnValue({ ...record, status: "rejected" });
    const resumed = await resumeTask(task.id);

    expect(resumed.status).toBe("completed");
    const toolMessage = resumed.messages.find((m) => m.role === "tool");
    expect(toolMessage && JSON.parse(toolMessage.content)).toEqual({
      rejected: true,
      message: "The user rejected this tool execution.",
    });
  });

  it("feeds a completed execution's full result (incl. parsedOutput) back and continues", async () => {
    mockStreamAgentChat.mockImplementation(
      repliesGenerator(['{"tool": "list_directory", "arguments": ["."]}', "Here's the listing."]),
    );
    const record = fixtureExecution({
      status: "pending_confirmation",
      toolId: "list_directory",
    });
    mockRequestExecution.mockResolvedValue(record);
    const task = await createTask("test-agent", "objective", "proj-5");

    const finished = fixtureExecution({
      ...record,
      status: "completed",
      result: { ...record.result!, parsedOutput: ["a.txt", "b.txt"] },
    });
    mockGetExecution.mockReturnValue(finished);
    const resumed = await resumeTask(task.id);

    expect(resumed.status).toBe("completed");
    const toolMessage = resumed.messages.find((m) => m.role === "tool");
    const parsed = toolMessage && JSON.parse(toolMessage.content);
    expect(parsed.parsedOutput).toEqual(["a.txt", "b.txt"]);
    expect(parsed.stdout).toBe(record.result!.stdout);
  });

  it("reaches max_time_reached once the task has been alive past the time cap", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "bash", "arguments": []}']));
    const record = fixtureExecution({ status: "pending_confirmation" });
    mockRequestExecution.mockResolvedValue(record);
    const task = await createTask("test-agent", "objective", "proj-6");
    mockGetExecution.mockReturnValue({ ...record, status: "rejected" });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(task.createdAt + env.maxOrchestratorTaskTimeMs + 1000));

    const resumed = await resumeTask(task.id);
    expect(resumed.status).toBe("max_time_reached");
  });

  it("pauses at waiting_guidance (instead of auto-continuing) when the execution failed", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "bash", "arguments": []}']));
    const record = fixtureExecution({ status: "pending_confirmation" });
    mockRequestExecution.mockResolvedValue(record);
    const task = await createTask("test-agent", "objective", "proj-7");

    const failed = fixtureExecution({
      ...record,
      status: "failed",
      result: { ...record.result!, success: false, exitCode: 1, stderr: "command not found" },
    });
    mockGetExecution.mockReturnValue(failed);
    const resumed = await resumeTask(task.id);

    expect(resumed.status).toBe("waiting_guidance");
    // The failed result is still recorded in the transcript, and the pending execution id is kept
    // around (not cleared) so the UI can still show what actually failed.
    expect(resumed.pendingExecutionId).toBe(record.id);
    const toolMessage = resumed.messages.find((m) => m.role === "tool");
    const parsed = toolMessage && JSON.parse(toolMessage.content);
    expect(parsed.success).toBe(false);
    expect(parsed.stderr).toBe("command not found");
    // Only one agent call so far (the initial tool request) - it hasn't auto-continued.
    expect(mockStreamAgentChat).toHaveBeenCalledTimes(1);
  });

  it("pauses at waiting_guidance when the execution was forcibly cancelled", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "bash", "arguments": []}']));
    const record = fixtureExecution({ status: "pending_confirmation" });
    mockRequestExecution.mockResolvedValue(record);
    const task = await createTask("test-agent", "objective", "proj-7b");

    mockGetExecution.mockReturnValue({ ...record, status: "cancelled", result: { ...record.result!, success: false, cancelled: true } });
    const resumed = await resumeTask(task.id);

    expect(resumed.status).toBe("waiting_guidance");
  });
});

describe("provideGuidance", () => {
  it("throws TaskNotFoundError for an unknown id", async () => {
    await expect(provideGuidance("nope", undefined)).rejects.toThrow(TaskNotFoundError);
  });

  it("throws InvalidTaskStateError when the task isn't waiting on guidance", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(["done"]));
    const task = await createTask("test-agent", "objective", "proj-8");

    expect(task.status).toBe("completed");
    await expect(provideGuidance(task.id, undefined)).rejects.toThrow(InvalidTaskStateError);
  });

  it("continues without adding a message when no note is given", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "nope", "arguments": []}', "Fine, here's 7."]));
    mockRequestExecution.mockRejectedValueOnce(new Error("Unknown tool"));
    const task = await createTask("test-agent", "objective", "proj-9");
    expect(task.status).toBe("waiting_guidance");
    const messageCountBefore = task.messages.length;

    const resumed = await provideGuidance(task.id, undefined);

    expect(resumed.status).toBe("completed");
    expect(resumed.finalResponse).toBe("Fine, here's 7.");
    // No note given -> no extra user message beyond what was already there before continuing.
    expect(resumed.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(resumed.messages.length).toBe(messageCountBefore + 1); // + the new assistant reply
  });

  it("appends a trimmed note as a user message and it reaches the next agent call", async () => {
    mockStreamAgentChat.mockImplementation(
      repliesGenerator(['{"tool": "nope", "arguments": []}', "Got it, using httpx instead."]),
    );
    mockRequestExecution.mockRejectedValueOnce(new Error("Unknown tool"));
    const task = await createTask("test-agent", "objective", "proj-10");

    const resumed = await provideGuidance(task.id, "  that tool isn't installed, try httpx instead  ");

    expect(resumed.messages.some((m) => m.role === "user" && m.content === "that tool isn't installed, try httpx instead")).toBe(
      true,
    );
    const lastCall = mockStreamAgentChat.mock.calls.at(-1);
    const sentMessages = (lastCall?.[0] as { messages: { role: string; content: string }[] }).messages;
    expect(sentMessages.some((m) => m.content === "that tool isn't installed, try httpx instead")).toBe(true);
  });

  it("a blank/whitespace-only note is treated the same as no note", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "nope", "arguments": []}', "ok"]));
    mockRequestExecution.mockRejectedValueOnce(new Error("Unknown tool"));
    const task = await createTask("test-agent", "objective", "proj-11");

    const resumed = await provideGuidance(task.id, "   ");

    expect(resumed.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("can request another tool call after being given guidance, landing back on waiting_confirmation", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "nope", "arguments": []}', '{"tool": "httpx", "arguments": []}']));
    mockRequestExecution.mockRejectedValueOnce(new Error("Unknown tool"));
    const task = await createTask("test-agent", "objective", "proj-12");

    const record = fixtureExecution({ toolId: "httpx", status: "pending_confirmation" });
    mockRequestExecution.mockResolvedValueOnce(record);
    const resumed = await provideGuidance(task.id, "try httpx instead");

    expect(resumed.status).toBe("waiting_confirmation");
    expect(resumed.pendingExecutionId).toBe(record.id);
  });

  it("keeps using the task's model override when resuming from guidance", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "nope", "arguments": []}', "done"]));
    mockRequestExecution.mockRejectedValueOnce(new Error("Unknown tool"));
    const task = await createTask("test-agent", "objective", "proj-13", undefined, undefined, "override-model");

    await provideGuidance(task.id);

    const lastCall = mockStreamAgentChat.mock.calls.at(-1);
    expect(lastCall?.[0]).toEqual(expect.objectContaining({ model: "override-model" }));
  });

  it("stops at max_executions_reached once the cap is hit across repeated guidance rounds", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "nope", "arguments": []}']));
    mockRequestExecution.mockRejectedValue(new Error("Unknown tool"));

    let task = await createTask("test-agent", "objective", "proj-14");
    for (let i = 0; i < env.maxOrchestratorToolCalls + 1 && task.status === "waiting_guidance"; i++) {
      task = await provideGuidance(task.id);
    }

    expect(task.status).toBe("max_executions_reached");
    expect(task.toolCallCount).toBe(env.maxOrchestratorToolCalls);
  });

  it("reaches max_time_reached if the task's overall time cap has passed", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "nope", "arguments": []}']));
    mockRequestExecution.mockRejectedValueOnce(new Error("Unknown tool"));
    const task = await createTask("test-agent", "objective", "proj-15");

    vi.useFakeTimers();
    vi.setSystemTime(new Date(task.createdAt + env.maxOrchestratorTaskTimeMs + 1000));

    const resumed = await provideGuidance(task.id);
    expect(resumed.status).toBe("max_time_reached");
  });
});

describe("continueTask", () => {
  it("throws TaskNotFoundError for an unknown id", async () => {
    await expect(continueTask("nope", "keep going")).rejects.toThrow(TaskNotFoundError);
  });

  it("throws InvalidTaskStateError when the task isn't completed", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "bash", "arguments": []}']));
    const record = fixtureExecution({ status: "pending_confirmation" });
    mockRequestExecution.mockResolvedValue(record);
    const task = await createTask("test-agent", "objective", "proj-7");

    expect(task.status).toBe("waiting_confirmation");
    await expect(continueTask(task.id, "keep going")).rejects.toThrow(InvalidTaskStateError);
  });

  it("appends the follow-up as a user message and keeps advancing the same task", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(["First answer.", "Second answer."]));
    const task = await createTask("test-agent", "objective", "proj-8");
    expect(task.status).toBe("completed");

    const continued = await continueTask(task.id, "and what about the other host?");

    expect(continued.id).toBe(task.id);
    expect(continued.status).toBe("completed");
    expect(continued.finalResponse).toBe("Second answer.");
    expect(continued.messages.map((m) => ({ role: m.role, content: m.content }))).toEqual([
      { role: "user", content: "objective" },
      { role: "assistant", content: "First answer." },
      { role: "user", content: "and what about the other host?" },
      { role: "assistant", content: "Second answer." },
    ]);
  });

  it("preserves toolExecutionIds/toolCallCount from before the continuation", async () => {
    mockStreamAgentChat.mockImplementation(
      repliesGenerator(['{"tool": "bash", "arguments": []}', "Done.", "Also done."]),
    );
    const record = fixtureExecution({ status: "pending_confirmation" });
    mockRequestExecution.mockResolvedValue(record);
    const task = await createTask("test-agent", "objective", "proj-9");
    mockGetExecution.mockReturnValue({ ...record, status: "completed" });
    const resumed = await resumeTask(task.id);
    expect(resumed.status).toBe("completed");
    expect(resumed.toolCallCount).toBe(1);

    const continued = await continueTask(task.id, "one more thing");

    expect(continued.toolExecutionIds).toEqual(resumed.toolExecutionIds);
    expect(continued.toolCallCount).toBe(1);
  });

  it("can request another tool call after being continued", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(["Done.", '{"tool": "bash", "arguments": []}']));
    const task = await createTask("test-agent", "objective", "proj-10");
    expect(task.status).toBe("completed");

    const record = fixtureExecution({ status: "pending_confirmation" });
    mockRequestExecution.mockResolvedValue(record);
    const continued = await continueTask(task.id, "now run this");

    expect(continued.status).toBe("waiting_confirmation");
    expect(continued.pendingExecutionId).toBe(record.id);
  });

  it("still respects the task's original time cap after a continuation", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(["Done."]));
    const task = await createTask("test-agent", "objective", "proj-11");

    vi.useFakeTimers();
    vi.setSystemTime(new Date(task.createdAt + env.maxOrchestratorTaskTimeMs + 1000));

    const continued = await continueTask(task.id, "keep going");
    expect(continued.status).toBe("max_time_reached");
  });
});

describe("cancelTask", () => {
  it("throws TaskNotFoundError for an unknown id", () => {
    expect(() => cancelTask("nope")).toThrow(TaskNotFoundError);
  });

  it("rejects (not cancels) a pending execution that never started running", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "bash", "arguments": []}']));
    const record = fixtureExecution({ status: "pending_confirmation" });
    mockRequestExecution.mockResolvedValue(record);
    const task = await createTask("test-agent", "objective", "proj-7");
    mockGetExecution.mockReturnValue(record);

    const cancelled = cancelTask(task.id);

    // The execution never started running (no confirm yet), so there's no process to abort -
    // rejectExecution is the correct terminal state ("this tool call never happened"), not
    // cancelExecution, which only works on an execution with a registered AbortController.
    expect(mockRejectExecution).toHaveBeenCalledWith(record.id);
    expect(mockCancelExecution).not.toHaveBeenCalled();
    expect(cancelled.status).toBe("cancelled");
  });

  it("cancels (not rejects) an execution that's already running", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "bash", "arguments": []}']));
    const record = fixtureExecution({ status: "pending_confirmation" });
    mockRequestExecution.mockResolvedValue(record);
    const task = await createTask("test-agent", "objective", "proj-7b");
    mockGetExecution.mockReturnValue({ ...record, status: "running" });

    const cancelled = cancelTask(task.id);

    expect(mockCancelExecution).toHaveBeenCalledWith(record.id);
    expect(mockRejectExecution).not.toHaveBeenCalled();
    expect(cancelled.status).toBe("cancelled");
  });

  it("still marks the task cancelled if rejectExecution/cancelExecution throws (already finished)", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "bash", "arguments": []}']));
    const record = fixtureExecution({ status: "pending_confirmation" });
    mockRequestExecution.mockResolvedValue(record);
    const task = await createTask("test-agent", "objective", "proj-8");
    mockGetExecution.mockReturnValue(record);
    mockRejectExecution.mockImplementation(() => {
      throw new Error("already finished");
    });

    expect(() => cancelTask(task.id)).not.toThrow();
    expect(cancelTask(task.id).status).toBe("cancelled");
  });
});
