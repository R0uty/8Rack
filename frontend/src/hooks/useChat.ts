import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, streamChat } from "../services/api";
import type { ChatMessage, ChatOptions } from "../types/chat";

const SESSION_STORAGE_KEY = "8rack:chat-history";
/** Aborts a request if no data has been received for this long (guards against a hung connection). */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

let nextId = 0;
function createId(): string {
  nextId += 1;
  return `msg-${Date.now()}-${nextId}`;
}

function loadSessionMessages(): ChatMessage[] {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatMessage[];
    // A reload interrupts any in-flight generation; nothing is streaming anymore.
    return parsed.map((m) => (m.streaming ? { ...m, streaming: false } : m));
  } catch {
    return [];
  }
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>(loadSessionMessages);
  const [sending, setSending] = useState(false);
  const messagesRef = useRef<ChatMessage[]>(messages);
  const abortRef = useRef<AbortController | null>(null);

  const updateMessages = useCallback((updater: (prev: ChatMessage[]) => ChatMessage[]) => {
    setMessages((prev) => {
      const next = updater(prev);
      messagesRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(messages));
  }, [messages]);

  const sendMessage = useCallback(
    async (
      content: string,
      config: {
        /** When set, the backend Agent Manager supplies the model + systemPrompt — see api.ts#streamChat. */
        agentId?: string;
        /** Required when agentId is omitted. */
        model?: string;
        options?: ChatOptions;
        /** Ignored when agentId is set (the backend injects the agent's own system prompt instead). */
        systemPrompt?: string;
        keepAlive?: string;
        tools?: string[];
      },
    ) => {
      const { agentId, model, options, systemPrompt, keepAlive, tools } = config;
      const trimmed = content.trim();
      if (!trimmed || sending || !(agentId || model)) return;

      const userMessage: ChatMessage = {
        id: createId(),
        role: "user",
        content: trimmed,
        createdAt: Date.now(),
      };
      let currentAssistantId: string | null = createId();
      const assistantMessage: ChatMessage = {
        id: currentAssistantId,
        role: "assistant",
        content: "",
        createdAt: Date.now(),
        streaming: true,
      };

      const history = [
        ...(!agentId && systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
        ...[...messagesRef.current, userMessage]
          // Tool-result messages are internal to a single request/response round-trip and
          // aren't valid input roles for a fresh /api/chat call (see chat.ts#isValidMessages).
          .filter((m) => m.role !== "tool")
          .map(({ role, content }) => ({ role, content })),
      ];
      updateMessages((prev) => [...prev, userMessage, assistantMessage]);
      setSending(true);

      const controller = new AbortController();
      abortRef.current = controller;

      const startIdleTimer = () =>
        setTimeout(() => {
          controller.abort(new DOMException("Timed out waiting for a response", "TimeoutError"));
        }, IDLE_TIMEOUT_MS);
      let idleTimer = startIdleTimer();
      const armIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = startIdleTimer();
      };

      try {
        await streamChat(
          { agentId, model, messages: history, options, keepAlive, tools },
          (event) => {
            armIdleTimer();

            if (event.role === "tool") {
              updateMessages((prev) => [
                ...prev,
                { id: createId(), role: "tool", content: event.content, createdAt: Date.now() },
              ]);
              return;
            }

            if (event.toolCalls?.length) {
              const finishedId = currentAssistantId;
              // Defer creating the next assistant bubble until content actually starts arriving
              // again (see below) — otherwise it gets inserted before the tool-result message
              // that streamChatWithTools yields next, putting the transcript out of order.
              currentAssistantId = null;
              updateMessages((prev) =>
                prev.map((m) => (m.id === finishedId ? { ...m, toolCalls: event.toolCalls, streaming: false } : m)),
              );
              return;
            }

            if (currentAssistantId === null) {
              currentAssistantId = createId();
              const newId = currentAssistantId;
              updateMessages((prev) => [
                ...prev,
                { id: newId, role: "assistant", content: event.content, createdAt: Date.now(), streaming: !event.done },
              ]);
              return;
            }

            const activeId = currentAssistantId;
            updateMessages((prev) =>
              prev.map((m) =>
                m.id === activeId ? { ...m, content: m.content + event.content, streaming: !event.done } : m,
              ),
            );
          },
          controller.signal,
        );
      } catch (err) {
        const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
        const isCancelled = !isTimeout && err instanceof DOMException && err.name === "AbortError";
        const message = isTimeout
          ? "Request timed out waiting for a response from Ollama."
          : isCancelled
            ? undefined
            : err instanceof ApiError
              ? err.message
              : err instanceof Error
                ? err.message
                : "Something went wrong";

        updateMessages((prev) =>
          // currentAssistantId can be null here if the error lands between a tool call and the
          // follow-up completion (see the toolCalls branch above), so there's no bubble to attach
          // the error to yet — append a fresh one instead of updating in place.
          currentAssistantId && prev.some((m) => m.id === currentAssistantId)
            ? prev.map((m) =>
                m.id === currentAssistantId ? { ...m, streaming: false, error: message, cancelled: isCancelled } : m,
              )
            : [
                ...prev,
                {
                  id: createId(),
                  role: "assistant" as const,
                  content: "",
                  createdAt: Date.now(),
                  streaming: false,
                  error: message,
                  cancelled: isCancelled,
                },
              ],
        );
      } finally {
        clearTimeout(idleTimer);
        abortRef.current = null;
        setSending(false);
      }
    },
    [sending, updateMessages],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    updateMessages(() => []);
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  }, [updateMessages]);

  return { messages, sending, sendMessage, cancel, clear };
}
