import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../config/env.js";
import { chat, embed, listModels, streamChat } from "./ollama.js";
import {
  EmbeddingModelUnavailableError,
  OllamaConnectionError,
  OllamaModelNotFoundError,
  OllamaRequestError,
  OllamaTimeoutError,
  RequestCancelledError,
} from "./errors.js";
import type { ChatRequest, ToolCall } from "../types/ollama.js";


function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  };
}

/** A fake streaming Response - `chunks` are raw byte strings fed to sequential reader.read()
 * calls, letting a test control exactly how NDJSON lines are split across reads (or deliberately
 * split mid-line, to exercise streamChat's own buffering). */
function streamResponse(chunks: string[], init: { ok?: boolean; status?: number } = {}) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => ({ error: "json() shouldn't be called on a streaming response" }),
    body: {
      getReader: () => ({
        read: async () => {
          if (index >= chunks.length) return { done: true, value: undefined };
          const value = encoder.encode(chunks[index]);
          index++;
          return { done: false, value };
        },
        releaseLock: () => undefined,
      }),
    },
  };
}

/** Same shape, but reader.read() throws an AbortError on its `failAt`-th call (0-indexed) instead
 * of ever reaching the end of `chunks` - simulates a fetch aborted mid-stream. */
function abortedStreamResponse(chunks: string[], failAt: number) {
  const encoder = new TextEncoder();
  let calls = 0;
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    body: {
      getReader: () => ({
        read: async () => {
          if (calls === failAt) {
            calls++;
            throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
          }
          const value = calls < chunks.length ? encoder.encode(chunks[calls]) : undefined;
          calls++;
          return value === undefined ? { done: true, value: undefined } : { done: false, value };
        },
        releaseLock: () => undefined,
      }),
    },
  };
}

function ndjsonLine(overrides: { content?: string; tool_calls?: ToolCall[]; done?: boolean } = {}): string {
  return `${JSON.stringify({
    model: "test-model",
    created_at: "2026-01-01T00:00:00Z",
    message: { role: "assistant", content: overrides.content ?? "", tool_calls: overrides.tool_calls },
    done: overrides.done ?? true,
  })}\n`;
}

const baseRequest: ChatRequest = { model: "test-model", messages: [{ role: "user", content: "hi" }] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listModels", () => {
  it("returns the parsed model list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ models: [{ name: "m1" }] })));
    expect(await listModels()).toEqual([{ name: "m1" }]);
  });

  it("throws OllamaRequestError on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, { ok: false, status: 500 })));
    await expect(listModels()).rejects.toThrow(OllamaRequestError);
  });

  it("throws OllamaConnectionError when the network request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(listModels()).rejects.toThrow(OllamaConnectionError);
  });

  it("throws OllamaTimeoutError when the request times out", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("timeout"), { name: "TimeoutError" })));
    await expect(listModels()).rejects.toThrow(OllamaTimeoutError);
  });

  it("passes a bounded AbortSignal on the request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ models: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await listModels();
    const init = fetchMock.mock.calls[0][1] as { signal?: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("embed", () => {
  it("returns embeddings on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ embeddings: [[0.1, 0.2]] })));
    expect(await embed("nomic-embed-text", ["hello"])).toEqual([[0.1, 0.2]]);
  });

  it("throws EmbeddingModelUnavailableError when the model isn't found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "model not found" }, { ok: false, status: 404 })),
    );
    await expect(embed("nope", ["x"])).rejects.toThrow(EmbeddingModelUnavailableError);
  });

  it("throws EmbeddingModelUnavailableError when the model doesn't support embeddings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "does not support embeddings" }, { ok: false, status: 400 })),
    );
    await expect(embed("qwen2.5-coder:7b", ["x"])).rejects.toThrow(EmbeddingModelUnavailableError);
  });

  it("throws a plain OllamaRequestError for any other failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "internal error" }, { ok: false, status: 500 })));
    await expect(embed("m", ["x"])).rejects.toThrow(OllamaRequestError);
  });

  it("throws OllamaRequestError if the response is missing embeddings", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({})));
    await expect(embed("m", ["x"])).rejects.toThrow(OllamaRequestError);
  });

  it("throws OllamaTimeoutError when the request times out", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("timeout"), { name: "TimeoutError" })));
    await expect(embed("m", ["x"])).rejects.toThrow(OllamaTimeoutError);
  });

  it("passes a bounded AbortSignal on the request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ embeddings: [[0.1]] }));
    vi.stubGlobal("fetch", fetchMock);
    await embed("m", ["x"]);
    const init = fetchMock.mock.calls[0][1] as { signal?: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe("streamChat", () => {
  it("yields one chunk per NDJSON line", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(streamResponse([ndjsonLine({ content: "hi", done: false }), ndjsonLine({ content: "!", done: true })])),
    );
    const chunks = await collect(streamChat(baseRequest));
    expect(chunks.map((c) => c.message.content)).toEqual(["hi", "!"]);
  });

  it("buffers a line split across two reads", async () => {
    const full = ndjsonLine({ content: "reconstructed" });
    const splitPoint = Math.floor(full.length / 2);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse([full.slice(0, splitPoint), full.slice(splitPoint)])));

    const chunks = await collect(streamChat(baseRequest));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].message.content).toBe("reconstructed");
  });

  it("flushes a final line with no trailing newline once the stream ends", async () => {
    const withoutNewline = ndjsonLine({ content: "no newline" }).trimEnd();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse([withoutNewline])));

    const chunks = await collect(streamChat(baseRequest));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].message.content).toBe("no newline");
  });

  it("throws OllamaModelNotFoundError for a 404 'not found' response naming the request's model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "model 'test-model' not found" }, { ok: false, status: 404 })),
    );
    await expect(collect(streamChat(baseRequest))).rejects.toThrow(OllamaModelNotFoundError);
  });

  it("throws a plain OllamaRequestError for a non-404 failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "server error" }, { ok: false, status: 500 })));
    await expect(collect(streamChat(baseRequest))).rejects.toThrow(OllamaRequestError);
  });

  it("throws OllamaRequestError when the response has no body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, body: null }));
    await expect(collect(streamChat(baseRequest))).rejects.toThrow(OllamaRequestError);
  });

  it("throws OllamaRequestError for a line that isn't valid JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse(["not valid json\n"])));
    await expect(collect(streamChat(baseRequest))).rejects.toThrow(OllamaRequestError);
  });

  it("throws RequestCancelledError when the stream is aborted mid-read", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(abortedStreamResponse([ndjsonLine({ done: false })], 1)));
    await expect(collect(streamChat(baseRequest))).rejects.toThrow(RequestCancelledError);
  });

  it("throws RequestCancelledError when the initial fetch itself is aborted", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" })));
    await expect(collect(streamChat(baseRequest))).rejects.toThrow(RequestCancelledError);
  });

  it("throws OllamaConnectionError when the initial fetch fails for any other reason", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(collect(streamChat(baseRequest))).rejects.toThrow(OllamaConnectionError);
  });

  it("throws OllamaTimeoutError when the stream goes idle for longer than the configured bound", async () => {
    vi.useFakeTimers();
    try {
      // A connection that's gone genuinely silent: the reader's read() never resolves on its own,
      // only when the signal passed into fetch() (the idle-timeout-combined one) actually aborts -
      // mirroring how a real fetch/undici stream reacts to its governing AbortSignal firing.
      const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => ({
        ok: true,
        status: 200,
        json: async () => ({}),
        body: {
          getReader: () => ({
            read: () =>
              new Promise((_resolve, reject) => {
                init.signal?.addEventListener("abort", () => {
                  reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
                });
              }),
            releaseLock: () => undefined,
          }),
        },
      }));
      vi.stubGlobal("fetch", fetchMock);

      const next = streamChat(baseRequest).next();
      next.catch(() => {}); // see cveLookup.test.ts#callQueryNvd for why this is safe/needed
      await vi.advanceTimersByTimeAsync(env.ollamaChatIdleTimeoutMs);
      await expect(next).rejects.toThrow(OllamaTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not time out a slow-but-alive stream that keeps producing chunks within the idle window", async () => {
    vi.useFakeTimers();
    try {
      let resolveRead: ((v: { done: boolean; value?: Uint8Array }) => void) | undefined;
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
        body: {
          getReader: () => ({
            read: () => new Promise((resolve) => (resolveRead = resolve)),
            releaseLock: () => undefined,
          }),
        },
      });
      vi.stubGlobal("fetch", fetchMock);

      const gen = streamChat(baseRequest);
      const first = gen.next();

      // A chunk arrives just under the idle deadline - this must reset the timer, not let it lapse.
      await vi.advanceTimersByTimeAsync(env.ollamaChatIdleTimeoutMs - 1000);
      resolveRead?.({
        done: false,
        value: new TextEncoder().encode(ndjsonLine({ content: "still going", done: false })),
      });
      const chunk = await first;
      expect(chunk.value?.message.content).toBe("still going");

      // Another near-full window elapses from that reset point - still shouldn't time out.
      const second = gen.next();
      await vi.advanceTimersByTimeAsync(env.ollamaChatIdleTimeoutMs - 1000);
      resolveRead?.({ done: true, value: undefined });
      const result = await second;
      expect(result.done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("streamChat mid-stream errors", () => {
  it("throws on an {error} line after streaming began, rather than ending as a normal reply", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(streamResponse([ndjsonLine({ content: "partial", done: false }), '{"error":"model runner has unexpectedly stopped"}\n'])),
    );

    await expect(collect(streamChat({ model: "m", messages: [] }))).rejects.toThrow("model runner has unexpectedly stopped");
  });
});

describe("chat", () => {
  it("collects a full completion by concatenating streamed content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(streamResponse([ndjsonLine({ content: "Hel", done: false }), ndjsonLine({ content: "lo", done: true })])),
    );
    const result = await chat(baseRequest);
    expect(result.message.content).toBe("Hello");
    expect(result.done).toBe(true);
  });

  it("throws OllamaRequestError if the stream yields no data at all", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse([])));
    await expect(chat(baseRequest)).rejects.toThrow(OllamaRequestError);
  });
});

