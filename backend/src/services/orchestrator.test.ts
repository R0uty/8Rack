import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgent } from "./agentManager.js";
import { streamAgentChat } from "./chatService.js";
import { cancelExecution, getExecution, requestExecution } from "./toolManager.js";
import { env } from "../config/env.js";
import {
  AgentNotFoundError,
  InvalidTaskStateError,
  RequestCancelledError,
  TaskNotFoundError,
} from "./errors.js";
import { cancelTask, createTask, listTasks, parseToolRequest, resumeTask } from "./orchestrator.js";
import type { AgentWithStatus } from "../types/agent.js";
import type { ChatResponseChunk } from "../types/ollama.js";
import type { ExecutionRecord } from "../types/execTool.js";

vi.mock("./agentManager.js", () => ({ getAgent: vi.fn() }));
vi.mock("./chatService.js", () => ({ streamAgentChat: vi.fn() }));
vi.mock("./toolManager.js", () => ({
  requestExecution: vi.fn(),
  getExecution: vi.fn(),
  cancelExecution: vi.fn(),
  listExecTools: vi.fn(() => []),
}));
vi.mock("./projectStore.js", () => ({
  listProjectIds: vi.fn(async () => []),
  readProjectJson: vi.fn(async () => []),
  writeProjectJson: vi.fn(async () => undefined),
}));

const mockGetAgent = vi.mocked(getAgent);
const mockStreamAgentChat = vi.mocked(streamAgentChat);
const mockRequestExecution = vi.mocked(requestExecution);
const mockGetExecution = vi.mocked(getExecution);
const mockCancelExecution = vi.mocked(cancelExecution);

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

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAgent.mockResolvedValue(fixtureAgent);
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

  it("requests the tool and lands on waiting_confirmation for a valid tool request", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "bash", "arguments": ["-c", "ls"]}']));
    const record = fixtureExecution({ projectId: "proj-1" });
    mockRequestExecution.mockResolvedValue(record);

    const task = await createTask("test-agent", "List files", "proj-1");

    expect(mockRequestExecution).toHaveBeenCalledWith({ tool: "bash", arguments: ["-c", "ls"], projectId: "proj-1" });
    expect(task.status).toBe("waiting_confirmation");
    expect(task.pendingExecutionId).toBe(record.id);
    expect(task.toolExecutionIds).toContain(record.id);
    expect(task.toolCallCount).toBe(1);
  });

  it("retries internally when the tool request is invalid, then completes", async () => {
    mockStreamAgentChat.mockImplementation(
      repliesGenerator(['{"tool": "nope", "arguments": []}', "Never mind, here's your answer: 7."]),
    );
    mockRequestExecution.mockRejectedValueOnce(new Error("Unknown tool"));

    const task = await createTask("test-agent", "objective", "proj-1");

    expect(task.status).toBe("completed");
    expect(task.toolCallCount).toBe(1);
    expect(task.messages.some((m) => m.role === "tool" && m.content.includes("Unknown tool"))).toBe(true);
  });

  it("stops at max_executions_reached once the tool-call cap is hit", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "nope", "arguments": []}']));
    mockRequestExecution.mockRejectedValue(new Error("Unknown tool"));

    const task = await createTask("test-agent", "objective", "proj-1");

    expect(task.status).toBe("max_executions_reached");
    expect(task.toolCallCount).toBe(env.maxOrchestratorToolCalls);
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

describe("resumeTask", () => {
  it("throws TaskNotFoundError for an unknown id", async () => {
    await expect(resumeTask("nope")).rejects.toThrow(TaskNotFoundError);
  });

  it("throws InvalidTaskStateError when the task isn't waiting on a confirmation", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(["done"]));
    const task = await createTask("test-agent", "objective", "proj-2");

    await expect(resumeTask(task.id)).rejects.toThrow(InvalidTaskStateError);
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
});

describe("cancelTask", () => {
  it("throws TaskNotFoundError for an unknown id", () => {
    expect(() => cancelTask("nope")).toThrow(TaskNotFoundError);
  });

  it("cancels the pending execution and marks the task cancelled", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "bash", "arguments": []}']));
    const record = fixtureExecution({ status: "pending_confirmation" });
    mockRequestExecution.mockResolvedValue(record);
    const task = await createTask("test-agent", "objective", "proj-7");

    const cancelled = cancelTask(task.id);

    expect(mockCancelExecution).toHaveBeenCalledWith(record.id);
    expect(cancelled.status).toBe("cancelled");
  });

  it("still marks the task cancelled if cancelExecution throws (already finished)", async () => {
    mockStreamAgentChat.mockImplementation(repliesGenerator(['{"tool": "bash", "arguments": []}']));
    const record = fixtureExecution({ status: "pending_confirmation" });
    mockRequestExecution.mockResolvedValue(record);
    const task = await createTask("test-agent", "objective", "proj-8");
    mockCancelExecution.mockImplementation(() => {
      throw new Error("already finished");
    });

    expect(() => cancelTask(task.id)).not.toThrow();
    expect(cancelTask(task.id).status).toBe("cancelled");
  });
});
