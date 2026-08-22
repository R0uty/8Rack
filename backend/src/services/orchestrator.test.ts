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
  getTask,
  listTasks,
  parseToolRequest,
  provideGuidance,
  resumeTask,
} from "./orchestrator.js";
import { getStatus as getRagStatus, search as searchKnowledgeBase } from "./ragIndex.js";
import { createFinding, getMissionFindings } from "./findingsManager.js";
import { queryNvd } from "./cveLookup.js";
import { getMission, onMissionDeleted } from "./missionManager.js";
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
vi.mock("./missionStore.js", () => ({
  listMissionIds: vi.fn(async () => []),
  readMissionJson: vi.fn(async () => []),
  writeMissionJson: vi.fn(async () => undefined),
}));
vi.mock("./missionManager.js", () => ({ getMission: vi.fn(async () => undefined), onMissionDeleted: vi.fn() }));
vi.mock("./ragIndex.js", () => ({ getStatus: vi.fn(), search: vi.fn() }));
vi.mock("./cveLookup.js", () => ({ queryNvd: vi.fn() }));

const mockOnMissionDeleted = vi.mocked(onMissionDeleted);
/** Captured once, synchronously, right here at module load - every module in this test's import
 * graph that calls onMissionDeleted(...) at its own top level (orchestrator.ts's own handler, plus
 * findingsManager.ts's transitively) registered by now, in whatever order ESM evaluated their
 * imports. Must be captured before any test runs: the file's own `beforeEach(() =>
 * vi.clearAllMocks())` below wipes mockOnMissionDeleted.mock.calls before every test, and these
 * registrations only ever happen once, at import time - reading the array lazily inside
 * purgeMission would see it empty by the time any test body actually calls it. */
const registeredPurgeHandlers = mockOnMissionDeleted.mock.calls.map(([handler]) => handler);
/** Replicates exactly what the real (mocked-away) missionManager.ts#deleteMission does: call every
 * registered handler for the given id. */
function purgeMission(missionId: string) {
  for (const handler of registeredPurgeHandlers) handler(missionId);
}

const mockGetAgent = vi.mocked(getAgent);
const mockStreamAgentChat = vi.mocked(streamAgentChat);
const mockRequestExecution = vi.mocked(requestExecution);
const mockListExecTools = vi.mocked(listExecTools);
const mockGetExecution = vi.mocked(getExecution);
const mockCancelExecution = vi.mocked(cancelExecution);
const mockRejectExecution = vi.mocked(rejectExecution);
const mockGetRagStatus = vi.mocked(getRagStatus);
const mockSearchKnowledgeBase = vi.mocked(searchKnowledgeBase);
const mockGetMission = vi.mocked(getMission);
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
    missionId: "proj-1",
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
    // Second arg is always a real per-task AbortSignal now (advanceTask creates one even when the
    // caller doesn't pass one, so cancelTask can always reach an in-flight generation) - not the
    // literal `undefined` a caller-omitted signal used to pass straight through as.
    expect(mockStreamAgentChat).toHaveBeenCalledWith(
      expect.objectContaining({ model: "override-model" }),
      expect.any(AbortSignal),
    );
  });

  it("omits model (falls back to the agent's own) when no override is given", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(["hi"]));

    const task = await createTask("test-agent", "objective", "proj-1");

    expect(task.model).toBeUndefined();
    expect(mockStreamAgentChat).toHaveBeenCalledWith(
      expect.objectContaining({ model: undefined }),
      expect.any(AbortSignal),
    );
  });

  it("requests the tool and lands on waiting_confirmation for a valid tool request", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "bash", "arguments": ["-c", "ls"]}']));
    const record = fixtureExecution({ missionId: "proj-1" });
    mockRequestExecution.mockResolvedValue(record);

    const task = await createTask("test-agent", "List files", "proj-1");

    expect(mockRequestExecution).toHaveBeenCalledWith({
      tool: "bash",
      arguments: ["-c", "ls"],
      missionId: "proj-1",
      agentId: "test-agent",
    });
    expect(task.status).toBe("waiting_confirmation");
    expect(task.pendingExecutionId).toBe(record.id);
    expect(task.toolExecutionIds).toContain(record.id);
    expect(task.toolCallCount).toBe(1);
  });

  it("splits a write_file request's second argument into stdin instead of a literal argv element", async () => {
    mockStreamAgentChat.mockImplementation(
      repliesGenerator(['{"tool": "write_file", "arguments": ["notes.txt", "line one\\nline two"]}']),
    );
    mockRequestExecution.mockResolvedValue(fixtureExecution({ toolId: "write_file" }));

    await createTask("test-agent", "Save these notes", "proj-1");

    expect(mockRequestExecution).toHaveBeenCalledWith({
      tool: "write_file",
      arguments: ["notes.txt"],
      missionId: "proj-1",
      agentId: "test-agent",
      stdin: "line one\nline two",
    });
  });

  it("passes undefined stdin for a write_file request with no content argument", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "write_file", "arguments": ["notes.txt"]}']));
    mockRequestExecution.mockResolvedValue(fixtureExecution({ toolId: "write_file" }));

    await createTask("test-agent", "Create an empty file", "proj-1");

    expect(mockRequestExecution).toHaveBeenCalledWith({
      tool: "write_file",
      arguments: ["notes.txt"],
      missionId: "proj-1",
      agentId: "test-agent",
      stdin: undefined,
    });
  });

  it("does not split a non-write_file tool's arguments into stdin", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "bash", "arguments": ["-c", "ls"]}']));
    mockRequestExecution.mockResolvedValue(fixtureExecution());

    await createTask("test-agent", "List files", "proj-1");

    const [[call]] = mockRequestExecution.mock.calls;
    expect(call.arguments).toEqual(["-c", "ls"]);
    expect(call.stdin).toBeUndefined();
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

  it("appends a tool's usageHint after its description in the preamble, when it has one", async () => {
    mockListExecTools.mockReturnValue([
      fixtureExecTool({ id: "nmap", usageHint: 'Use for port scanning. arguments: ["-sV", "<host>"]' }),
      fixtureExecTool({ id: "dig" }), // no usageHint - must not blow up or leave a stray trailing space
    ]);
    mockStreamAgentChat.mockImplementation(repliesGenerator(["no tool needed"]));

    await createTask("test-agent", "objective", "proj-1");

    const [[request]] = mockStreamAgentChat.mock.calls;
    expect(request.toolsPreamble).toContain(
      '- nmap: Queries DNS records for a domain. Use for port scanning. arguments: ["-sV", "<host>"]',
    );
    expect(request.toolsPreamble).toContain("- dig: Queries DNS records for a domain.\n");
  });

  it("prepends mission context to the tools preamble when the mission has scope/rules/etc configured", async () => {
    mockListExecTools.mockReturnValue([fixtureExecTool({ id: "dig" })]);
    mockGetMission.mockResolvedValueOnce({
      id: "proj-1",
      name: "Acme Pentest",
      notes: "",
      createdAt: 0,
      description: "External web app assessment",
      scope: ["example.com", "*.example.com"],
      outOfScope: ["staging.example.com"],
      rules: "No automated DoS testing",
      status: "recon",
    });
    mockStreamAgentChat.mockImplementation(repliesGenerator(["no tool needed"]));

    await createTask("test-agent", "objective", "proj-1");

    const [[request]] = mockStreamAgentChat.mock.calls;
    expect(request.toolsPreamble).toContain("Mission: Acme Pentest (status: recon)");
    expect(request.toolsPreamble).toContain("Description: External web app assessment");
    expect(request.toolsPreamble).toContain("Scope (authorized targets): example.com, *.example.com");
    expect(request.toolsPreamble).toContain("Out of scope (never target these): staging.example.com");
    expect(request.toolsPreamble).toContain("Rules of engagement: No automated DoS testing");
  });

  it("omits mission context entirely for a mission with no mission fields set", async () => {
    mockListExecTools.mockReturnValue([fixtureExecTool({ id: "dig" })]);
    mockGetMission.mockResolvedValueOnce({ id: "proj-1", name: "Plain Mission", notes: "", createdAt: 0 });
    mockStreamAgentChat.mockImplementation(repliesGenerator(["no tool needed"]));

    await createTask("test-agent", "objective", "proj-1");

    const [[request]] = mockStreamAgentChat.mock.calls;
    expect(request.toolsPreamble).not.toContain("Mission:");
  });

  it("never crashes tool-calling if the mission lookup for mission context fails", async () => {
    mockListExecTools.mockReturnValue([fixtureExecTool({ id: "dig" })]);
    mockGetMission.mockRejectedValueOnce(new Error("disk error"));
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
      missionId: "proj-1",
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
    const missionId = "proj-findings-1";
    await createFinding(missionId, {
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

    const task = await createTask("test-agent", "What's known?", missionId);

    expect(mockRequestExecution).not.toHaveBeenCalled();
    expect(task.status).toBe("completed");
    const toolMessage = task.messages.find((m) => m.role === "tool");
    const parsed = JSON.parse(toolMessage!.content);
    expect(parsed).toMatchObject({ tool: "query_findings", success: true });
    expect(parsed.stdout).toContain("Port 80/tcp open");
  });

  it("filters by type when a type argument is given", async () => {
    const missionId = "proj-findings-2";
    await createFinding(missionId, {
      type: "port",
      severity: "info",
      title: "Port A",
      description: "d",
      target: "t",
      value: "80/tcp",
    });
    await createFinding(missionId, {
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

    const task = await createTask("test-agent", "objective", missionId);
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
    const missionId = "proj-findings-3";
    await createFinding(missionId, {
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

    const task = await createTask("test-agent", "objective", missionId);
    const toolMessage = task.messages.find((m) => m.role === "tool");
    expect(JSON.parse(toolMessage!.content).success).toBe(false);
  });
});

describe("lookup_cves tool", () => {
  it("skips confirmation entirely and creates a linked cve finding", async () => {
    const missionId = "proj-cve-1";
    await createFinding(missionId, {
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

    const task = await createTask("test-agent", "Check nginx for CVEs", missionId);

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
    const missionId = "proj-cve-2";
    mockQueryNvd.mockResolvedValue([
      { id: "CVE-2021-5678", description: "d", cvssScore: 5.0, cvssSeverity: "medium", cvssVector: null, references: [] },
    ]);
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "lookup_cves", "arguments": ["apache"]}', "ok"]));

    const task = await createTask("test-agent", "objective", missionId);
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
    const missionId = "proj-create-finding-1";
    mockStreamAgentChat.mockImplementation(
      repliesGenerator([`{"tool": "create_finding", "arguments": [${JSON.stringify(validPayload)}]}`, "Recorded."]),
    );

    const task = await createTask("recon-agent", "find bugs", missionId);

    expect(mockRequestExecution).not.toHaveBeenCalled();
    expect(task.status).toBe("completed");
    const toolMessage = task.messages.find((m) => m.role === "tool");
    const parsed = JSON.parse(toolMessage!.content);
    expect(parsed).toMatchObject({ tool: "create_finding", success: true });

    const [finding] = getMissionFindings(missionId);
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
    expect(finding.evidence).toEqual([
      {
        id: expect.any(String),
        type: "agent_reasoning",
        content: "raw HTTP exchange",
        createdAt: expect.any(Number),
        agentId: "recon-agent",
        executionId: undefined,
      },
    ]);
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
    expect(getMissionFindings("proj-create-finding-3")).toHaveLength(0);
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

describe("validate_finding tool", () => {
  it("is always listed in the preamble, with no precondition", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(["no tool needed"]));
    await createTask("test-agent", "objective", "proj-validate-finding-preamble");
    const [[request]] = mockStreamAgentChat.mock.calls;
    expect(request.toolsPreamble).toContain("validate_finding");
  });

  it("records a verdict, severity, and reasoning-as-evidence against an existing finding in the same mission", async () => {
    const missionId = "proj-validate-finding-1";
    const finding = await createFinding(missionId, {
      type: "potential_vulnerability",
      severity: "medium",
      title: "Reflected XSS in search",
      description: "The q parameter is reflected unescaped.",
      target: "example.com",
      value: "/search?q",
    });

    const payload = JSON.stringify({
      findingId: finding.id,
      verdict: "confirmed",
      severity: "high",
      notes: "Reproduced against /search?q=<script>...; reflected unescaped in response body.",
    });
    mockStreamAgentChat.mockImplementation(
      repliesGenerator([`{"tool": "validate_finding", "arguments": [${JSON.stringify(payload)}]}`, "Validated."]),
    );

    const task = await createTask("vulnerability-validator", "validate this finding", missionId);

    expect(task.status).toBe("completed");
    const toolMessage = task.messages.find((m) => m.role === "tool");
    const parsed = JSON.parse(toolMessage!.content);
    expect(parsed).toMatchObject({ tool: "validate_finding", success: true });

    const [updated] = getMissionFindings(missionId);
    expect(updated.status).toBe("confirmed");
    expect(updated.severity).toBe("high");
    expect(updated.validatedBy).toBe("vulnerability-validator");
    expect(updated.relatedAgents).toContain("vulnerability-validator");
    expect(updated.evidence).toContainEqual(
      expect.objectContaining({
        type: "agent_reasoning",
        content: "Reproduced against /search?q=<script>...; reflected unescaped in response body.",
        agentId: "vulnerability-validator",
      }),
    );
  });

  it("rejects a findingId that belongs to a different mission", async () => {
    const otherMissionFinding = await createFinding("proj-validate-finding-other", {
      type: "potential_vulnerability",
      severity: "low",
      title: "x",
      description: "d",
      target: "t",
      value: "v",
    });

    const payload = JSON.stringify({ findingId: otherMissionFinding.id, verdict: "confirmed", notes: "n" });
    mockStreamAgentChat.mockImplementation(
      repliesGenerator([`{"tool": "validate_finding", "arguments": [${JSON.stringify(payload)}]}`, "ok"]),
    );

    const task = await createTask("test-agent", "objective", "proj-validate-finding-2");
    const toolMessage = task.messages.find((m) => m.role === "tool");
    const parsed = JSON.parse(toolMessage!.content);
    expect(parsed.success).toBe(false);
    expect(parsed.message).toContain("No finding");
  });

  it("reports a validation error and recovers instead of crashing on an invalid verdict", async () => {
    mockStreamAgentChat.mockImplementation(
      repliesGenerator(['{"tool": "validate_finding", "arguments": ["{\\"findingId\\":\\"x\\",\\"verdict\\":\\"maybe\\",\\"notes\\":\\"n\\"}"]}', "ok"]),
    );

    const task = await createTask("test-agent", "objective", "proj-validate-finding-3");

    expect(task.status).toBe("completed");
    const toolMessage = task.messages.find((m) => m.role === "tool");
    const parsed = JSON.parse(toolMessage!.content);
    expect(parsed.success).toBe(false);
    expect(parsed.message).toContain("verdict");
  });

  it("requires non-empty notes explaining the reasoning", async () => {
    const finding = await createFinding("proj-validate-finding-4", {
      type: "potential_vulnerability",
      severity: "low",
      title: "x",
      description: "d",
      target: "t",
      value: "v",
    });
    const payload = JSON.stringify({ findingId: finding.id, verdict: "false_positive", notes: "" });
    mockStreamAgentChat.mockImplementation(
      repliesGenerator([`{"tool": "validate_finding", "arguments": [${JSON.stringify(payload)}]}`, "ok"]),
    );

    const task = await createTask("test-agent", "objective", "proj-validate-finding-4");
    const toolMessage = task.messages.find((m) => m.role === "tool");
    const parsed = JSON.parse(toolMessage!.content);
    expect(parsed.success).toBe(false);
    expect(parsed.message).toContain("notes");
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

  it("truncates a large stdout/stderr before storing it in the task transcript", async () => {
    mockStreamAgentChat.mockImplementation(
      repliesGenerator(['{"tool": "bash", "arguments": ["-c", "big"]}', "Done."]),
    );
    const record = fixtureExecution({ status: "pending_confirmation" });
    mockRequestExecution.mockResolvedValue(record);
    const task = await createTask("test-agent", "objective", "proj-transcript-1");

    const hugeStdout = "x".repeat(10_000);
    const hugeStderr = "e".repeat(10_000);
    mockGetExecution.mockReturnValue(
      fixtureExecution({
        ...record,
        status: "completed",
        result: { ...record.result!, stdout: hugeStdout, stderr: hugeStderr },
      }),
    );
    const resumed = await resumeTask(task.id);

    const toolMessage = resumed.messages.find((m) => m.role === "tool");
    const parsed = toolMessage && JSON.parse(toolMessage.content);
    expect(Buffer.byteLength(parsed.stdout, "utf-8")).toBeLessThan(hugeStdout.length);
    expect(parsed.stdout).toMatch(/\.\.\.\[truncated, showing 4000 of 10000 bytes\]$/);
    expect(parsed.stderr).toMatch(/\.\.\.\[truncated, showing 4000 of 10000 bytes\]$/);
  });

  it("leaves stdout/stderr untouched when under the truncation cap", async () => {
    mockStreamAgentChat.mockImplementation(
      repliesGenerator(['{"tool": "bash", "arguments": []}', "Done."]),
    );
    const record = fixtureExecution({ status: "pending_confirmation" });
    mockRequestExecution.mockResolvedValue(record);
    const task = await createTask("test-agent", "objective", "proj-transcript-2");

    mockGetExecution.mockReturnValue(fixtureExecution({ ...record, status: "completed" }));
    const resumed = await resumeTask(task.id);

    const toolMessage = resumed.messages.find((m) => m.role === "tool");
    const parsed = toolMessage && JSON.parse(toolMessage.content);
    expect(parsed.stdout).toBe("hi\n");
    expect(parsed.stdout).not.toContain("truncated");
  });

  it("caps a large array parsedOutput by item count, not just by bytes", async () => {
    mockStreamAgentChat.mockImplementation(
      repliesGenerator(['{"tool": "subfinder", "arguments": ["-d", "example.com"]}', "Done."]),
    );
    const record = fixtureExecution({ status: "pending_confirmation", toolId: "subfinder" });
    mockRequestExecution.mockResolvedValue(record);
    const task = await createTask("test-agent", "objective", "proj-transcript-3");

    const manySubdomains = Array.from({ length: 500 }, (_, i) => `sub${i}.example.com`);
    mockGetExecution.mockReturnValue(
      fixtureExecution({
        ...record,
        status: "completed",
        result: { ...record.result!, parsedOutput: manySubdomains },
      }),
    );
    const resumed = await resumeTask(task.id);

    const toolMessage = resumed.messages.find((m) => m.role === "tool");
    const parsed = toolMessage && JSON.parse(toolMessage.content);
    expect(parsed.parsedOutput).toHaveLength(201); // 200 items + one truncation-note entry
    expect(parsed.parsedOutput[0]).toBe("sub0.example.com");
    expect(parsed.parsedOutput.at(-1)).toMatch(/truncated, showing 200 of 500 items/);
  });

  it("falls back to a truncated serialized string for an oversized object parsedOutput", async () => {
    mockStreamAgentChat.mockImplementation(
      repliesGenerator(['{"tool": "nuclei", "arguments": ["-u", "https://example.com"]}', "Done."]),
    );
    const record = fixtureExecution({ status: "pending_confirmation", toolId: "nuclei" });
    mockRequestExecution.mockResolvedValue(record);
    const task = await createTask("test-agent", "objective", "proj-transcript-4");

    const bigObject = { findings: Array.from({ length: 1000 }, (_, i) => ({ id: i, note: "x".repeat(20) })) };
    mockGetExecution.mockReturnValue(
      fixtureExecution({
        ...record,
        status: "completed",
        result: { ...record.result!, parsedOutput: bigObject },
      }),
    );
    const resumed = await resumeTask(task.id);

    const toolMessage = resumed.messages.find((m) => m.role === "tool");
    const parsed = toolMessage && JSON.parse(toolMessage.content);
    expect(typeof parsed.parsedOutput).toBe("string");
    expect(parsed.parsedOutput).toContain("...[truncated");
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

  it("aborts a generation that's still in flight when cancelTask arrives from a different caller, and never spawns a new execution afterward", async () => {
    // Simulates the exact race the fix closes: a cancel arriving on a different connection than
    // the one that created the task, while streamAgentChat is still awaiting a reply. Before the
    // fix, cancelTask only flipped the in-memory status - this still-running call had no way to
    // find out and would keep going, potentially reaching requestExecution below.
    const generationStarted = new Promise<void>((resolveStarted) => {
      mockStreamAgentChat.mockImplementation(async function* (_req, signal) {
        resolveStarted();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new RequestCancelledError()));
        });
        // Unreachable once aborted, but present so this stays a valid AsyncGenerator if it weren't.
        yield { model: "test-model", created_at: "", message: { role: "assistant", content: '{"tool": "bash", "arguments": []}' }, done: true };
      });
    });

    // createTask propagates RequestCancelledError as a rejection (same existing contract as a
    // same-connection cancel - see advance()'s catch) rather than resolving with a cancelled-status
    // task, so attach a no-op catch immediately to avoid an unhandled-rejection warning while the
    // assertions below run against the in-memory task object instead.
    const taskPromise = createTask("test-agent", "objective", "proj-cancel-race");
    taskPromise.catch(() => {});
    await generationStarted;

    const [inFlightTask] = listTasks("proj-cancel-race");
    expect(inFlightTask.status).toBe("running");

    const cancelledNow = cancelTask(inFlightTask.id);
    expect(cancelledNow.status).toBe("cancelled");

    await expect(taskPromise).rejects.toThrow(RequestCancelledError);
    expect(listTasks("proj-cancel-race")[0].status).toBe("cancelled");
    expect(mockRequestExecution).not.toHaveBeenCalled();
  });

  it("blocks a tool execution if the task was cancelled in the gap between the reply and requestExecution", async () => {
    // There's no await between streamAgentChat resolving and requestExecution being called for a
    // plain tool request, so the only way to land a cancel in that exact window is to trigger it
    // from inside the mocked reply itself - this exercises the explicit `signal?.aborted` check in
    // advance() directly, independent of the RequestCancelledError path covered above.
    mockStreamAgentChat.mockImplementation(async function* () {
      const [current] = listTasks("proj-cancel-race-2");
      cancelTask(current.id);
      yield {
        model: "test-model",
        created_at: "",
        message: { role: "assistant", content: '{"tool": "bash", "arguments": []}' },
        done: true,
      };
    });

    const task = await createTask("test-agent", "objective", "proj-cancel-race-2");

    expect(task.status).toBe("cancelled");
    expect(mockRequestExecution).not.toHaveBeenCalled();
  });

  it("rejects the execution and stays cancelled if the cancel lands while requestExecution itself is still in flight", async () => {
    // A narrower version of the race above: this time the cancel arrives *during* requestExecution
    // (simulating its own internal awaits, e.g. getMission()/persistExecutions() in
    // toolManager.ts) rather than before it's called - so the execution genuinely gets created.
    // Without the post-call signal check, advance() would overwrite the "cancelled" status
    // cancelTask() just set back to "waiting_confirmation" once requestExecution resolves.
    mockStreamAgentChat.mockImplementation(
      repliesGenerator(['{"tool": "bash", "arguments": []}']),
    );
    const record = fixtureExecution({ status: "pending_confirmation" });
    mockRequestExecution.mockImplementation(async () => {
      const [current] = listTasks("proj-cancel-race-3");
      cancelTask(current.id);
      return record;
    });
    mockGetExecution.mockReturnValue(record);

    const task = await createTask("test-agent", "objective", "proj-cancel-race-3");

    expect(task.status).toBe("cancelled");
    expect(task.pendingExecutionId).toBeUndefined();
    expect(mockRejectExecution).toHaveBeenCalledWith(record.id);
  });
});

describe("mission deletion purges tasks (ghost-record regression coverage)", () => {
  it("removes a deleted mission's tasks from listTasks/getTask", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(["no tool needed"]));
    const task = await createTask("test-agent", "objective", "proj-purge-tasks-a");
    expect(getTask(task.id)).toBeDefined();

    purgeMission("proj-purge-tasks-a");

    expect(listTasks("proj-purge-tasks-a")).toEqual([]);
    expect(getTask(task.id)).toBeUndefined();
  });

  it("does not touch another mission's tasks", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(["no tool needed"]));
    const untouched = await createTask("test-agent", "objective", "proj-purge-tasks-untouched");
    await createTask("test-agent", "objective", "proj-purge-tasks-b");

    purgeMission("proj-purge-tasks-b");

    expect(getTask(untouched.id)).toBeDefined();
    expect(listTasks("proj-purge-tasks-untouched")).toHaveLength(1);
  });

  it("aborts a task whose generation is still in flight when its mission is deleted", async () => {
    // Same "createTask propagates RequestCancelledError as a rejection" contract as cancelTask's
    // own in-flight-abort test above, not a resolved cancelled-status task.
    const generationStarted = new Promise<void>((resolveStarted) => {
      mockStreamAgentChat.mockImplementation(async function* (_req, signal) {
        resolveStarted();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new RequestCancelledError()));
        });
        // Unreachable once aborted, but present so this stays a valid AsyncGenerator if it weren't.
        yield { model: "test-model", created_at: "", message: { role: "assistant", content: "" }, done: true };
      });
    });

    const taskPromise = createTask("test-agent", "objective", "proj-purge-tasks-running");
    taskPromise.catch(() => {});
    await generationStarted;
    const [inFlight] = listTasks("proj-purge-tasks-running");
    expect(inFlight.status).toBe("running");

    purgeMission("proj-purge-tasks-running");

    await expect(taskPromise).rejects.toThrow(RequestCancelledError);
    // Purged from the Map entirely (synchronously, inside the purge handler itself), not just
    // left there marked cancelled.
    expect(getTask(inFlight.id)).toBeUndefined();
  });
});
