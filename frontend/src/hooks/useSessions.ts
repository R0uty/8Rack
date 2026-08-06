import { useCallback, useEffect, useState } from "react";
import type { Tone } from "../components/ui";

export type SessionKind = "chat" | "task";

export interface SessionMeta {
  id: string;
  kind: SessionKind;
  /** null = a manual chat with no agent (just a model). */
  agentId: string | null;
  /** Seeded from the agent's default model at creation time — a per-session override (see
   * backend/src/services/chatService.ts#AgentChatRequest.model), never mutates the agent config. */
  model: string;
  createdAt: number;
  // Task sessions only — the Workbench "New Task" form collects objective/project before any tab
  // exists, so the newly created tab carries what it needs to auto-start itself once, on mount.
  projectId?: string;
  initialObjective?: string;
  /** Set once the task session has actually called start() - guards against re-firing
   * initialObjective (e.g. after a reload, where the task's own live state is already lost, same
   * as today's non-persisted Workbench task view). */
  started?: boolean;
}

interface ActiveIds {
  chat: string | null;
  task: string | null;
}

const STORAGE_KEY = "8rack:sessions";

function loadSessions(): SessionMeta[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as SessionMeta[];
  } catch {
    return [];
  }
}

let nextId = 0;
function createId(): string {
  nextId += 1;
  return `session-${Date.now()}-${nextId}`;
}

/**
 * Owns the list of open agent sessions (chat and task/Workbench alike) so multiple agents can be
 * worked with concurrently - each session is a distinct tab whose actual content (messages, a
 * running OrchestratorTask) lives in its own mounted component instance keyed by session id
 * (ChatSessionPanel / TaskSessionPanel), not here. This hook only tracks the lightweight metadata
 * and which tab is focused per kind.
 *
 * Chat enforces "one open session per agent" - opening an agent that already has a chat session
 * just focuses it instead of duplicating it, since a chat is one ongoing conversation thread.
 * Task sessions don't: each "Start Task" always opens a brand new session, even for an agent that
 * already has one running or completed - e.g. asking the Recon Agent to run nmap in one task and
 * ffuf in another, concurrently, is exactly the kind of thing a real workflow needs (a single task
 * is one objective/tool-run, not a thread to keep piling unrelated work into - see
 * hooks/useOrchestratorTask.ts#continueTask for actually continuing *one* task's own thread).
 * AgentNetwork.tsx already renders however many sibling session nodes an agent has, so this was
 * always meant to support N task sessions per agent, not just one.
 */
export function useSessions() {
  const [sessions, setSessions] = useState<SessionMeta[]>(loadSessions);
  const [active, setActive] = useState<ActiveIds>({ chat: null, task: null });
  // Live status per session (e.g. "sending" for a chat, task.status for a task) - reported by
  // whichever mounted panel owns that session's real state, read by SessionTabs and the
  // AgentNetwork map so both can show live activity without owning that state themselves.
  const [statuses, setStatuses] = useState<Record<string, Tone>>({});

  useEffect(() => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  }, [sessions]);

  const openChatSession = useCallback(
    (agentId: string | null, model: string): string => {
      const existing = sessions.find((s) => s.kind === "chat" && s.agentId === agentId);
      if (existing) {
        setActive((a) => ({ ...a, chat: existing.id }));
        return existing.id;
      }
      const id = createId();
      setSessions((prev) => [...prev, { id, kind: "chat", agentId, model, createdAt: Date.now() }]);
      setActive((a) => ({ ...a, chat: id }));
      return id;
    },
    [sessions],
  );

  const openTaskSession = useCallback(
    (agentId: string, model: string, projectId: string, objective: string): string => {
      // Deliberately no dedup against an existing session for this agent - see the doc comment
      // above. Each call is a distinct task/tool-run the user asked to start.
      const id = createId();
      setSessions((prev) => [
        ...prev,
        { id, kind: "task", agentId, model, projectId, initialObjective: objective, createdAt: Date.now() },
      ]);
      setActive((a) => ({ ...a, task: id }));
      return id;
    },
    [],
  );

  const closeSession = useCallback((id: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setActive((a) => ({
      chat: a.chat === id ? null : a.chat,
      task: a.task === id ? null : a.task,
    }));
  }, []);

  const setActiveChat = useCallback((id: string | null) => setActive((a) => ({ ...a, chat: id })), []);
  const setActiveTask = useCallback((id: string | null) => setActive((a) => ({ ...a, task: id })), []);

  const markTaskStarted = useCallback((id: string) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, started: true } : s)));
  }, []);

  /** Overrides a session's model after creation - e.g. a chat session's own header lets the user
   * change it mid-conversation. Never touches the agent's own config; purely per-session. */
  const setSessionModel = useCallback((id: string, model: string) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, model } : s)));
  }, []);

  const reportStatus = useCallback((id: string, tone: Tone) => {
    setStatuses((prev) => (prev[id] === tone ? prev : { ...prev, [id]: tone }));
  }, []);

  return {
    sessions,
    chatSessions: sessions.filter((s) => s.kind === "chat"),
    taskSessions: sessions.filter((s) => s.kind === "task"),
    activeChatId: active.chat,
    activeTaskId: active.task,
    statuses,
    openChatSession,
    openTaskSession,
    closeSession,
    setActiveChat,
    setActiveTask,
    markTaskStarted,
    setSessionModel,
    reportStatus,
  };
}

export type UseSessions = ReturnType<typeof useSessions>;
