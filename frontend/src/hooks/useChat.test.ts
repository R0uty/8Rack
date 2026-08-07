import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useChat } from "./useChat";
import { streamChat } from "../services/api";
import type { ChatStreamEvent } from "../services/api";

vi.mock("../services/api", async () => {
  const actual = await vi.importActual<typeof import("../services/api")>("../services/api");
  return { ...actual, streamChat: vi.fn() };
});

const mockStreamChat = vi.mocked(streamChat);

type OnEvent = (event: ChatStreamEvent) => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useChat", () => {
  it("sends a message and appends a completed assistant reply", async () => {
    mockStreamChat.mockImplementation(async (_payload, onEvent: OnEvent) => {
      onEvent({ role: "assistant", content: "Hi there", done: true });
    });

    const { result } = renderHook(() => useChat("session-1"));
    await act(async () => {
      await result.current.sendMessage("hello", { model: "test-model" });
    });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0]).toMatchObject({ role: "user", content: "hello" });
    expect(result.current.messages[1]).toMatchObject({ role: "assistant", content: "Hi there", streaming: false });
    expect(result.current.sending).toBe(false);
  });

  it("accumulates streamed content chunks into the same assistant message", async () => {
    mockStreamChat.mockImplementation(async (_payload, onEvent: OnEvent) => {
      onEvent({ role: "assistant", content: "Hel", done: false });
      onEvent({ role: "assistant", content: "lo", done: true });
    });

    const { result } = renderHook(() => useChat("session-1"));
    await act(async () => {
      await result.current.sendMessage("hi", { model: "test-model" });
    });

    const assistant = result.current.messages[1];
    expect(assistant.content).toBe("Hello");
    expect(assistant.streaming).toBe(false);
  });

  it("aborts an in-flight sendMessage when the hook unmounts", async () => {
    let capturedSignal: AbortSignal | undefined;
    const pending = deferred<void>();
    mockStreamChat.mockImplementation(async (_payload, _onEvent, signal) => {
      capturedSignal = signal;
      return pending.promise;
    });

    const { result, unmount } = renderHook(() => useChat("session-1"));
    act(() => {
      void result.current.sendMessage("hello", { model: "test-model" });
    });

    expect(capturedSignal?.aborted).toBe(false);
    unmount();
    expect(capturedSignal?.aborted).toBe(true);

    pending.resolve();
  });

  it("does nothing for blank content", async () => {
    const { result } = renderHook(() => useChat("session-1"));
    await act(async () => {
      await result.current.sendMessage("   ", { model: "test-model" });
    });
    expect(result.current.messages).toHaveLength(0);
    expect(mockStreamChat).not.toHaveBeenCalled();
  });

  it("does nothing when neither agentId nor model is given", async () => {
    const { result } = renderHook(() => useChat("session-1"));
    await act(async () => {
      await result.current.sendMessage("hello", {});
    });
    expect(result.current.messages).toHaveLength(0);
    expect(mockStreamChat).not.toHaveBeenCalled();
  });

  it("ignores a send while one is already in flight", async () => {
    const first = deferred<void>();
    mockStreamChat.mockReturnValueOnce(first.promise);

    const { result } = renderHook(() => useChat("session-1"));
    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendMessage("first", { model: "test-model" });
    });
    expect(result.current.sending).toBe(true);

    await act(async () => {
      await result.current.sendMessage("second", { model: "test-model" });
    });
    expect(mockStreamChat).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve();
      await sendPromise;
    });
  });

  it("renders a tool_calls announcement, then a tool result, then resumes a fresh assistant bubble", async () => {
    mockStreamChat.mockImplementation(async (_payload, onEvent: OnEvent) => {
      onEvent({ role: "assistant", content: "", toolCalls: [{ name: "calc", arguments: { expr: "1+1" } }], done: false });
      onEvent({ role: "tool", content: "2", done: false });
      onEvent({ role: "assistant", content: "The answer is 2", done: true });
    });

    const { result } = renderHook(() => useChat("session-1"));
    await act(async () => {
      await result.current.sendMessage("what is 1+1", { model: "test-model" });
    });

    const [, toolCallMsg, toolResultMsg, finalMsg] = result.current.messages;
    expect(toolCallMsg).toMatchObject({ role: "assistant", toolCalls: [{ name: "calc", arguments: { expr: "1+1" } }] });
    expect(toolResultMsg).toMatchObject({ role: "tool", content: "2" });
    expect(finalMsg).toMatchObject({ role: "assistant", content: "The answer is 2" });
  });

  it("excludes tool messages and prior streaming flags from the history sent to the backend", async () => {
    mockStreamChat.mockImplementation(async (_payload, onEvent: OnEvent) => {
      onEvent({ role: "tool", content: "irrelevant", done: false });
      onEvent({ role: "assistant", content: "ok", done: true });
    });

    const { result } = renderHook(() => useChat("session-1"));
    await act(async () => {
      await result.current.sendMessage("one", { model: "test-model" });
    });

    mockStreamChat.mockClear();
    mockStreamChat.mockImplementation(async (_payload, onEvent: OnEvent) => {
      onEvent({ role: "assistant", content: "ok2", done: true });
    });
    await act(async () => {
      await result.current.sendMessage("two", { model: "test-model" });
    });

    const payload = mockStreamChat.mock.calls[0][0];
    expect(payload.messages.some((m) => m.role === "tool")).toBe(false);
    expect(payload.messages.map((m) => m.content)).toEqual(["one", "ok", "two"]);
  });

  it("marks the message cancelled (no error) when the request is aborted by the user", async () => {
    mockStreamChat.mockImplementation((_payload, _onEvent, signal) => {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    });

    const { result } = renderHook(() => useChat("session-1"));
    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendMessage("hello", { model: "test-model" });
    });

    act(() => result.current.cancel());
    await act(async () => {
      await sendPromise;
    });

    const assistant = result.current.messages[1];
    expect(assistant.cancelled).toBe(true);
    expect(assistant.error).toBeUndefined();
    expect(assistant.streaming).toBe(false);
  });

  it("surfaces an ApiError message on the assistant bubble", async () => {
    const { ApiError } = await import("../services/api");
    mockStreamChat.mockRejectedValue(new ApiError("model not found", 404));

    const { result } = renderHook(() => useChat("session-1"));
    await act(async () => {
      await result.current.sendMessage("hello", { model: "test-model" });
    });

    expect(result.current.messages[1]).toMatchObject({ error: "model not found", cancelled: false, streaming: false });
  });

  it("appends a fresh error bubble when the error lands between a tool call and its follow-up", async () => {
    mockStreamChat.mockImplementation(async (_payload, onEvent: OnEvent) => {
      onEvent({ role: "assistant", content: "", toolCalls: [{ name: "calc", arguments: {} }], done: false });
      throw new Error("network dropped");
    });

    const { result } = renderHook(() => useChat("session-1"));
    await act(async () => {
      await result.current.sendMessage("hello", { model: "test-model" });
    });

    const messages = result.current.messages;
    expect(messages).toHaveLength(3);
    expect(messages[2]).toMatchObject({ role: "assistant", content: "", error: "network dropped" });
  });

  it("persists messages to sessionStorage keyed by sessionId, and loads them back with streaming cleared", async () => {
    mockStreamChat.mockImplementation(async (_payload, onEvent: OnEvent) => {
      onEvent({ role: "assistant", content: "partial", done: false });
    });

    const { result, unmount } = renderHook(() => useChat("session-A"));
    await act(async () => {
      await result.current.sendMessage("hello", { model: "test-model" });
    });
    unmount();

    const stored = JSON.parse(sessionStorage.getItem("8rack:chat-history:session-A")!);
    expect(stored).toHaveLength(2);
    expect(stored[1].streaming).toBe(true);

    const { result: reloaded } = renderHook(() => useChat("session-A"));
    expect(reloaded.current.messages).toHaveLength(2);
    expect(reloaded.current.messages[1].streaming).toBe(false);

    const { result: otherSession } = renderHook(() => useChat("session-B"));
    expect(otherSession.current.messages).toHaveLength(0);
  });

  it("clear() aborts and empties messages, leaving no history behind", async () => {
    mockStreamChat.mockImplementation(async (_payload, onEvent: OnEvent) => {
      onEvent({ role: "assistant", content: "hi", done: true });
    });
    const { result } = renderHook(() => useChat("session-1"));
    await act(async () => {
      await result.current.sendMessage("hello", { model: "test-model" });
    });
    expect(result.current.messages.length).toBeGreaterThan(0);

    act(() => result.current.clear());

    expect(result.current.messages).toHaveLength(0);
    // The removeItem() inside clear() runs before the persistence effect's next commit, so the
    // effect re-writes the (now empty) array right after - net effect is the same "no history".
    expect(JSON.parse(sessionStorage.getItem("8rack:chat-history:session-1") ?? "[]")).toEqual([]);
  });

  describe("idle timeout", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("aborts and reports a timeout after 5 minutes of silence", async () => {
      mockStreamChat.mockImplementation((_payload, _onEvent, signal) => {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
        });
      });

      const { result } = renderHook(() => useChat("session-1"));
      let sendPromise!: Promise<void>;
      act(() => {
        sendPromise = result.current.sendMessage("hello", { model: "test-model" });
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        await sendPromise;
      });

      const assistant = result.current.messages[1];
      expect(assistant.error).toBe("Request timed out waiting for a response from Ollama.");
      expect(assistant.cancelled).toBe(false);
    });

    it("a chunk arriving mid-flight resets the idle timer so it doesn't fire early", async () => {
      let onEventRef!: OnEvent;
      mockStreamChat.mockImplementation((_payload, onEvent: OnEvent, signal) => {
        onEventRef = onEvent;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
        });
      });

      const { result } = renderHook(() => useChat("session-1"));
      let sendPromise!: Promise<void>;
      act(() => {
        sendPromise = result.current.sendMessage("hello", { model: "test-model" });
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      });
      act(() => onEventRef({ role: "assistant", content: "still going", done: false }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      });

      expect(result.current.sending).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60 * 1000 + 1000);
        await sendPromise;
      });
      expect(result.current.messages[1].error).toBe("Request timed out waiting for a response from Ollama.");
    });
  });
});
