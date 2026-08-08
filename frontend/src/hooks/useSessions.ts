import { useCallback, useEffect, useMemo, useState } from "react";
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
  /** Task sessions: set by the Workbench "New Task" form before the tab even exists, so the new
   * tab carries what it needs to auto-start itself once, on mount. Chat sessions: set at creation
   * time from whichever project is currently selected on ChatView's own page-level selector (see
   * openChatSession below), or later via setSessionProject - either way, a set projectId opts that
   * chat into tool use, backed by an OrchestratorTask instead of a plain streamed reply, and is
   * also the key (alongside agentId) chat sessions dedup on - see components/chat/ChatTaskPanel.tsx. */
  projectId?: string;
  /** Task sessions only - see projectId above. */
  initialObjective?: string;
  /** Set once the task session has actually called start() - guards against re-firing
   * initialObjective (e.g. after a reload, where the task's own live state is already lost, same
   * as today's non-persisted Workbench task view). */
  started?: boolean;
  /** Chat sessions only - true while "closed" (hidden from the tab strip and the Command Center
   * map) but not actually discarded, so reopening the same agent resumes this exact conversation
   * (its messages are still in sessionStorage under this session's own id, see hooks/useChat.ts)
   * instead of silently starting a blank new one. Task sessions are never marked closed - closing
   * one really does discard it, see closeSession below. */
  closed?: boolean;
  /** Chat sessions with a project set only - the backend OrchestratorTask id backing this chat,
   * once ChatTaskPanel.tsx has actually started one. Unlike useChat.ts's plain messages,
   * useOrchestratorTask's task state is plain React state with no persistence of its own - this id
   * is what lets a reload (which wipes that state but not this sessionStorage-backed metadata)
   * refetch the task from the backend instead of the panel silently looking like a blank chat. */
  taskId?: string;
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
 * Chat enforces "one session per (agent, project) pair" - opening an agent that already has a chat
 * session for the currently-selected project (see ChatView.tsx's own page-level project selector,
 * matching Workbench/Findings/Scanners/Reports) just focuses it instead of duplicating it, since a
 * chat is one ongoing conversation thread; picking a different project and reopening the same agent
 * gets a genuinely separate thread. A chat session's `projectId` doubles as the existing
 * tool-enabling field (see below) - a project-scoped chat starts tool-enabled by design, not as a
 * separate opt-in. Closing a chat tab only hides it (SessionMeta.closed) rather than discarding it,
 * so reopening that same (agent, project) pair later resumes exactly where the conversation left
 * off instead of silently starting blank.
 * Task sessions don't: each "Start Task" always opens a brand new session, even for an agent that
 * already has one running or completed - e.g. asking the Recon Agent to run nmap in one task and
 * ffuf in another, concurrently, is exactly the kind of thing a real workflow needs (a single task
 * is one objective/tool-run, not a thread to keep piling unrelated work into - see
 * hooks/useOrchestratorTask.ts#continueTask for actually continuing *one* task's own thread).
 * AgentNetwork.tsx already renders however many sibling session nodes an agent has, so this was
 * always meant to support N task sessions per agent, not just one.
 */
export function useSessions() {
  // The full, persisted list - includes closed chat sessions (kept around so reopening the same
  // agent can resume them, see SessionMeta.closed). Everything else in the app should read
  // `sessions` below instead, which filters those back out.
  const [allSessions, setAllSessions] = useState<SessionMeta[]>(loadSessions);
  const [active, setActive] = useState<ActiveIds>({ chat: null, task: null });
  // Live status per session (e.g. "sending" for a chat, task.status for a task) - reported by
  // whichever mounted panel owns that session's real state, read by SessionTabs and the
  // AgentNetwork map so both can show live activity without owning that state themselves.
  const [statuses, setStatuses] = useState<Record<string, Tone>>({});

  useEffect(() => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(allSessions));
  }, [allSessions]);

  const sessions = useMemo(() => allSessions.filter((s) => !s.closed), [allSessions]);

  const openChatSession = useCallback(
    (agentId: string | null, model: string, projectId?: string): string => {
      const existing = allSessions.find(
        (s) => s.kind === "chat" && s.agentId === agentId && s.projectId === projectId,
      );
      if (existing) {
        if (existing.closed) {
          setAllSessions((prev) => prev.map((s) => (s.id === existing.id ? { ...s, closed: false } : s)));
        }
        setActive((a) => ({ ...a, chat: existing.id }));
        return existing.id;
      }
      const id = createId();
      setAllSessions((prev) => [...prev, { id, kind: "chat", agentId, model, projectId, createdAt: Date.now() }]);
      setActive((a) => ({ ...a, chat: id }));
      return id;
    },
    [allSessions],
  );

  const openTaskSession = useCallback(
    (agentId: string, model: string, projectId: string, objective: string): string => {
      // Deliberately no dedup against an existing session for this agent - see the doc comment
      // above. Each call is a distinct task/tool-run the user asked to start.
      const id = createId();
      setAllSessions((prev) => [
        ...prev,
        { id, kind: "task", agentId, model, projectId, initialObjective: objective, createdAt: Date.now() },
      ]);
      setActive((a) => ({ ...a, task: id }));
      return id;
    },
    [],
  );

  /** Chat sessions are hidden, not discarded (see SessionMeta.closed) - reopening the same agent
   * resumes the conversation instead of silently starting a blank new one. Task sessions really
   * are removed on close - each "Start Task" always creates a fresh session anyway (see the class
   * doc comment above), so there's nothing meaningful to resume. */
  const closeSession = useCallback((id: string) => {
    setAllSessions((prev) => {
      const target = prev.find((s) => s.id === id);
      if (!target) return prev;
      return target.kind === "chat"
        ? prev.map((s) => (s.id === id ? { ...s, closed: true } : s))
        : prev.filter((s) => s.id !== id);
    });
    setActive((a) => ({
      chat: a.chat === id ? null : a.chat,
      task: a.task === id ? null : a.task,
    }));
  }, []);

  const setActiveChat = useCallback((id: string | null) => setActive((a) => ({ ...a, chat: id })), []);
  const setActiveTask = useCallback((id: string | null) => setActive((a) => ({ ...a, task: id })), []);

  const markTaskStarted = useCallback((id: string) => {
    setAllSessions((prev) => prev.map((s) => (s.id === id ? { ...s, started: true } : s)));
  }, []);

  /** Overrides a session's model after creation - e.g. a chat session's own header lets the user
   * change it mid-conversation. Never touches the agent's own config; purely per-session. */
  const setSessionModel = useCallback((id: string, model: string) => {
    setAllSessions((prev) => prev.map((s) => (s.id === id ? { ...s, model } : s)));
  }, []);

  /** Chat sessions only - picking a project opts that chat into tool use (see ChatTaskPanel.tsx);
   * clearing it (undefined) has no effect on an already-started OrchestratorTask, just on what a
   * future reset()/reopen would do. */
  const setSessionProject = useCallback((id: string, projectId: string | undefined) => {
    setAllSessions((prev) => prev.map((s) => (s.id === id ? { ...s, projectId } : s)));
  }, []);

  /** Records which backend OrchestratorTask now backs a chat session - see SessionMeta.taskId. */
  const setSessionTaskId = useCallback((id: string, taskId: string) => {
    setAllSessions((prev) => prev.map((s) => (s.id === id ? { ...s, taskId } : s)));
  }, []);

  /** Drops any session (including closed-but-retained chat sessions) whose agent no longer
   * exists - deleting an agent otherwise left dangling sessionStorage entries forever, with no
   * eviction path (see TODO.md's audit findings). Manual/no-agent sessions (`agentId === null`)
   * are never pruned - only pass the *currently valid* agent id set, and only once it's actually
   * loaded (an empty set from a still-loading agents list would wrongly prune everything). */
  const pruneOrphanedSessions = useCallback((validAgentIds: Set<string>) => {
    setAllSessions((prev) => prev.filter((s) => s.agentId === null || validAgentIds.has(s.agentId)));
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
    setSessionProject,
    setSessionTaskId,
    pruneOrphanedSessions,
    reportStatus,
  };
}

export type UseSessions = ReturnType<typeof useSessions>;
