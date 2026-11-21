import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAgent } from "./agentManager.js";
import { streamChat } from "./ollama.js";
import { AgentDisabledError, AgentNotFoundError, AgentOfflineError } from "./errors.js";
import { streamAgentChat } from "./chatService.js";
import type { AgentWithStatus } from "../types/agent.js";
import type { ChatMessage, ChatResponseChunk } from "../types/ollama.js";

vi.mock("./agentManager.js", () => ({ getAgent: vi.fn() }));
vi.mock("./ollama.js", () => ({ streamChat: vi.fn() }));

const mockGetAgent = vi.mocked(getAgent);
const mockStreamChat = vi.mocked(streamChat);

const fixtureAgent: AgentWithStatus = {
  id: "planner",
  name: "Planner",
  description: "",
  model: "test-model",
  systemPrompt: "You are the Planner.",
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 0,
  icon: "",
  color: "",
  enabled: true,
  status: "online",
};

const fixtureChunk: ChatResponseChunk = {
  model: "test-model",
  created_at: "",
  message: { role: "assistant", content: "hi" },
  done: true,
};

async function drain(agentId: string, opts: Parameters<typeof streamAgentChat>[0] = { agentId, messages: [] }) {
  const chunks: ChatResponseChunk[] = [];
  for await (const chunk of streamAgentChat(opts)) chunks.push(chunk);
  return chunks;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAgent.mockResolvedValue(fixtureAgent);
  mockStreamChat.mockImplementation(async function* () {
    yield fixtureChunk;
  });
});

describe("agent validity checks", () => {
  it("throws AgentNotFoundError for an unknown agent", async () => {
    mockGetAgent.mockResolvedValue(undefined);
    await expect(drain("nope")).rejects.toThrow(AgentNotFoundError);
  });

  it("throws AgentDisabledError for a disabled agent", async () => {
    mockGetAgent.mockResolvedValue({ ...fixtureAgent, enabled: false });
    await expect(drain("planner")).rejects.toThrow(AgentDisabledError);
  });

  it("throws AgentOfflineError for an offline agent", async () => {
    mockGetAgent.mockResolvedValue({ ...fixtureAgent, status: "offline" });
    await expect(drain("planner")).rejects.toThrow(AgentOfflineError);
  });

  it("does not throw AgentOfflineError when a model override is given, even if the agent's own model is offline", async () => {
    mockGetAgent.mockResolvedValue({ ...fixtureAgent, status: "offline" });
    await expect(
      drain("planner", { agentId: "planner", messages: [], model: "override-model" }),
    ).resolves.not.toThrow();
  });
});

describe("model override", () => {
  it("uses the agent's configured model when no override is given", async () => {
    await drain("planner");
    const [{ model }] = mockStreamChat.mock.calls[0];
    expect(model).toBe("test-model");
  });

  it("uses the request's model instead of the agent's when an override is given", async () => {
    await drain("planner", { agentId: "planner", messages: [], model: "override-model" });
    const [{ model }] = mockStreamChat.mock.calls[0];
    expect(model).toBe("override-model");
  });
});

describe("system prompt + options assembly", () => {
  it("injects the agent's system prompt as the first message", async () => {
    await drain("planner", { agentId: "planner", messages: [{ role: "user", content: "hi" }] });

    const [{ messages }] = mockStreamChat.mock.calls[0];
    expect(messages[0]).toEqual({ role: "system", content: "You are the Planner." });
    expect(messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("appends toolsPreamble to the system prompt when provided", async () => {
    await drain("planner", { agentId: "planner", messages: [], toolsPreamble: "Available tools: bash" });

    const [{ messages }] = mockStreamChat.mock.calls[0];
    expect(messages[0].content).toBe("You are the Planner.\n\nAvailable tools: bash");
  });

  it("omits num_predict when the agent's maxTokens is 0", async () => {
    await drain("planner");
    const [{ options }] = mockStreamChat.mock.calls[0];
    expect(options).not.toHaveProperty("num_predict");
    expect(options).toMatchObject({ temperature: 0.7, top_p: 0.9 });
  });

  it("includes num_predict when the agent's maxTokens is > 0", async () => {
    mockGetAgent.mockResolvedValue({ ...fixtureAgent, maxTokens: 512 });
    await drain("planner");
    const [{ options }] = mockStreamChat.mock.calls[0];
    expect(options?.num_predict).toBe(512);
  });

  it("layers per-request options on top of the agent's own settings", async () => {
    await drain("planner", { agentId: "planner", messages: [], options: { temperature: 0.1 } });
    const [{ options }] = mockStreamChat.mock.calls[0];
    expect(options?.temperature).toBe(0.1);
    expect(options?.top_p).toBe(0.9);
  });

  // Without num_ctx Ollama uses 2048 tokens and silently drops the start of a longer prompt - the
  // Orchestrator's system prompt alone is about that long.
  it("always sends OLLAMA_NUM_CTX as the context window", async () => {
    await drain("planner");
    const [{ options }] = mockStreamChat.mock.calls[0];
    expect(options?.num_ctx).toBe(16_384);
  });

  it("lets a request set its own context window", async () => {
    await drain("planner", { agentId: "planner", messages: [], options: { num_ctx: 4096 } });
    expect(mockStreamChat.mock.calls[0][0].options?.num_ctx).toBe(4096);
  });
});

describe("prompt cut warning", () => {
  it("warns when the prompt filled the context window", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockStreamChat.mockImplementation(async function* () {
      yield { ...fixtureChunk, prompt_eval_count: 2050 };
    });
    await drain("planner", { agentId: "planner", messages: [], options: { num_ctx: 2048 } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("filled the whole context window (2050 of 2048 tokens)"));
    warn.mockRestore();
  });

  it("stays quiet when the prompt fits", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockStreamChat.mockImplementation(async function* () {
      yield { ...fixtureChunk, prompt_eval_count: 6964 };
    });
    const chunks = await drain("planner");
    expect(warn).not.toHaveBeenCalled();
    expect(chunks).toHaveLength(1);
    warn.mockRestore();
  });
});

describe("passthrough", () => {
  it("yields exactly what the underlying generator produced", async () => {
    const custom: ChatResponseChunk = {
      model: "m",
      created_at: "t",
      message: { role: "assistant", content: "custom content" },
      done: false,
    };
    mockStreamChat.mockImplementation(async function* () {
      yield custom;
    });

    const chunks = await drain("planner");
    expect(chunks).toEqual([custom]);
  });
});

describe("context budget", () => {
  it("sends older tool results shortened when the transcript would overflow the window", async () => {
    const messages: ChatMessage[] = [{ role: "user", content: "objective" }];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "assistant", content: "{}" });
      messages.push({ role: "tool", content: JSON.stringify({ tool: `t${i}`, success: true, stdout: "x".repeat(8000) }) });
    }

    await drain("planner", { agentId: "planner", messages });

    const sent = mockStreamChat.mock.calls[0][0].messages;
    expect(sent[0].role).toBe("system");
    expect(sent[1].content).toBe("objective");
    expect(sent.filter((m) => m.content.includes('"elided":true')).length).toBeGreaterThan(0);
    expect(sent.at(-1)!.content).toBe(messages.at(-1)!.content);
  });
});
