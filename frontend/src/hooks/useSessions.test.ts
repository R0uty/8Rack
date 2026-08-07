import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSessions } from "./useSessions";

const STORAGE_KEY = "8rack:sessions";

describe("useSessions", () => {
  it("starts empty when nothing is stored", () => {
    const { result } = renderHook(() => useSessions());
    expect(result.current.sessions).toEqual([]);
    expect(result.current.activeChatId).toBeNull();
    expect(result.current.activeTaskId).toBeNull();
  });

  it("restores previously stored sessions", () => {
    const stored = [{ id: "s1", kind: "chat", agentId: "planner", model: "m1", createdAt: 1 }];
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    const { result } = renderHook(() => useSessions());
    expect(result.current.chatSessions).toEqual(stored);
  });

  it("falls back to empty on corrupt stored JSON", () => {
    sessionStorage.setItem(STORAGE_KEY, "{not json");
    const { result } = renderHook(() => useSessions());
    expect(result.current.sessions).toEqual([]);
  });

  it("openChatSession() creates a new session and focuses it", () => {
    const { result } = renderHook(() => useSessions());

    let id!: string;
    act(() => {
      id = result.current.openChatSession("planner", "model-a");
    });

    expect(result.current.chatSessions).toHaveLength(1);
    expect(result.current.chatSessions[0]).toMatchObject({ id, kind: "chat", agentId: "planner", model: "model-a" });
    expect(result.current.activeChatId).toBe(id);
  });

  it("openChatSession() for an agent with an existing chat session focuses it instead of duplicating", () => {
    const { result } = renderHook(() => useSessions());

    let firstId!: string;
    act(() => {
      firstId = result.current.openChatSession("planner", "model-a");
    });
    act(() => result.current.setActiveChat(null));

    let secondId!: string;
    act(() => {
      secondId = result.current.openChatSession("planner", "model-b");
    });

    expect(secondId).toBe(firstId);
    expect(result.current.chatSessions).toHaveLength(1);
    expect(result.current.activeChatId).toBe(firstId);
  });

  it("supports one manual (agentId: null) chat session and one per real agent independently", () => {
    const { result } = renderHook(() => useSessions());

    // Each open happens in its own act() (a separate render in between), matching how these calls
    // actually arrive - one user interaction, and thus one commit, at a time.
    act(() => result.current.openChatSession(null, "model-a"));
    act(() => result.current.openChatSession("planner", "model-a"));
    act(() => result.current.openChatSession(null, "model-a"));

    expect(result.current.chatSessions).toHaveLength(2);
  });

  it("openTaskSession() creates a task session carrying project/objective, separate from chat sessions", () => {
    const { result } = renderHook(() => useSessions());

    let id!: string;
    act(() => {
      id = result.current.openTaskSession("recon", "model-a", "proj-1", "scan the target");
    });

    expect(result.current.taskSessions).toEqual([
      {
        id,
        kind: "task",
        agentId: "recon",
        model: "model-a",
        projectId: "proj-1",
        initialObjective: "scan the target",
        createdAt: expect.any(Number),
      },
    ]);
    expect(result.current.activeTaskId).toBe(id);
    expect(result.current.chatSessions).toHaveLength(0);
  });

  it("openTaskSession() never dedups - a second call for the same agent opens a distinct, second session and focuses it", () => {
    const { result } = renderHook(() => useSessions());

    let firstId!: string, secondId!: string;
    act(() => {
      firstId = result.current.openTaskSession("recon", "model-a", "proj-1", "run nmap");
    });
    act(() => {
      secondId = result.current.openTaskSession("recon", "model-a", "proj-1", "run ffuf");
    });

    expect(secondId).not.toBe(firstId);
    expect(result.current.taskSessions).toHaveLength(2);
    expect(result.current.taskSessions.map((s) => s.initialObjective)).toEqual(["run nmap", "run ffuf"]);
    expect(result.current.activeTaskId).toBe(secondId);
  });

  it("a chat and a task session for the same agent coexist (independent per kind)", () => {
    const { result } = renderHook(() => useSessions());

    act(() => {
      result.current.openChatSession("recon", "model-a");
      result.current.openTaskSession("recon", "model-a", "proj-1", "go");
    });

    expect(result.current.chatSessions).toHaveLength(1);
    expect(result.current.taskSessions).toHaveLength(1);
  });

  it("closeSession() removes the session and clears active if it was focused", () => {
    const { result } = renderHook(() => useSessions());

    let id!: string;
    act(() => {
      id = result.current.openChatSession("planner", "model-a");
    });
    expect(result.current.activeChatId).toBe(id);

    act(() => result.current.closeSession(id));

    expect(result.current.chatSessions).toHaveLength(0);
    expect(result.current.activeChatId).toBeNull();
  });

  it("closing a chat session hides it, but reopening the same agent resumes it (same id, not a duplicate)", () => {
    const { result } = renderHook(() => useSessions());

    let id!: string;
    act(() => {
      id = result.current.openChatSession("recon", "model-a");
    });
    act(() => result.current.setSessionModel(id, "model-custom"));
    act(() => result.current.closeSession(id));

    expect(result.current.chatSessions).toHaveLength(0);
    expect(result.current.activeChatId).toBeNull();

    let reopenedId!: string;
    act(() => {
      reopenedId = result.current.openChatSession("recon", "model-a");
    });

    expect(reopenedId).toBe(id);
    expect(result.current.chatSessions).toHaveLength(1);
    // The session's own state (e.g. a per-session model override) survives the close/reopen too,
    // since it was only ever hidden, not recreated.
    expect(result.current.chatSessions[0].model).toBe("model-custom");
    expect(result.current.activeChatId).toBe(id);
  });

  it("closing a task session fully discards it - reopening the agent starts a distinct new one", () => {
    const { result } = renderHook(() => useSessions());

    let id!: string;
    act(() => {
      id = result.current.openTaskSession("recon", "model-a", "proj-1", "run nmap");
    });
    act(() => result.current.closeSession(id));

    expect(result.current.taskSessions).toHaveLength(0);

    let secondId!: string;
    act(() => {
      secondId = result.current.openTaskSession("recon", "model-a", "proj-1", "run nmap again");
    });

    expect(secondId).not.toBe(id);
    expect(result.current.taskSessions).toHaveLength(1);
  });

  it("markTaskStarted() flags only the targeted session", () => {
    const { result } = renderHook(() => useSessions());

    let id1!: string, id2!: string;
    act(() => {
      id1 = result.current.openTaskSession("recon", "m", "p1", "a");
      id2 = result.current.openTaskSession("planner", "m", "p1", "b");
    });

    act(() => result.current.markTaskStarted(id1));

    expect(result.current.taskSessions.find((s) => s.id === id1)?.started).toBe(true);
    expect(result.current.taskSessions.find((s) => s.id === id2)?.started).toBeUndefined();
  });

  it("setSessionModel() overrides a session's model in place", () => {
    const { result } = renderHook(() => useSessions());

    let id!: string;
    act(() => {
      id = result.current.openChatSession("planner", "model-a");
    });
    act(() => result.current.setSessionModel(id, "model-b"));

    expect(result.current.chatSessions[0].model).toBe("model-b");
  });

  it("setSessionProject() opts a chat session into tool use, and can clear it back out", () => {
    const { result } = renderHook(() => useSessions());

    let id!: string;
    act(() => {
      id = result.current.openChatSession("recon", "model-a");
    });
    expect(result.current.chatSessions[0].projectId).toBeUndefined();

    act(() => result.current.setSessionProject(id, "proj-1"));
    expect(result.current.chatSessions[0].projectId).toBe("proj-1");

    act(() => result.current.setSessionProject(id, undefined));
    expect(result.current.chatSessions[0].projectId).toBeUndefined();
  });

  it("setSessionTaskId() records which backend task backs a chat session", () => {
    const { result } = renderHook(() => useSessions());

    let id!: string;
    act(() => {
      id = result.current.openChatSession("recon", "model-a");
    });
    expect(result.current.chatSessions[0].taskId).toBeUndefined();

    act(() => result.current.setSessionTaskId(id, "task-1"));
    expect(result.current.chatSessions[0].taskId).toBe("task-1");
  });

  it("reportStatus() records a tone per session id and is a no-op when unchanged", () => {
    const { result } = renderHook(() => useSessions());

    act(() => result.current.reportStatus("s1", "primary"));
    expect(result.current.statuses).toEqual({ s1: "primary" });

    const before = result.current.statuses;
    act(() => result.current.reportStatus("s1", "primary"));
    expect(result.current.statuses).toBe(before);

    act(() => result.current.reportStatus("s1", "critical"));
    expect(result.current.statuses).toEqual({ s1: "critical" });
  });

  it("pruneOrphanedSessions() drops sessions whose agent no longer exists", () => {
    const { result } = renderHook(() => useSessions());

    let chatId!: string, manualId!: string;
    act(() => {
      chatId = result.current.openChatSession("recon", "model-a");
      result.current.openTaskSession("planner", "model-a", "proj-1", "go");
      manualId = result.current.openChatSession(null, "model-a");
    });

    act(() => result.current.pruneOrphanedSessions(new Set(["recon"])));

    expect(result.current.chatSessions.map((s) => s.id).sort()).toEqual([chatId, manualId].sort());
    expect(result.current.taskSessions).toHaveLength(0);
    // Manual (no-agent) sessions are never pruned, regardless of validAgentIds.
    expect(result.current.sessions.some((s) => s.id === manualId)).toBe(true);
  });

  it("pruneOrphanedSessions() also drops a closed-but-retained chat session for a deleted agent", () => {
    const { result } = renderHook(() => useSessions());

    let id!: string;
    act(() => {
      id = result.current.openChatSession("recon", "model-a");
    });
    act(() => result.current.closeSession(id));
    expect(result.current.chatSessions).toHaveLength(0); // hidden, but still retained internally

    act(() => result.current.pruneOrphanedSessions(new Set()));

    // Reopening "recon" now creates a genuinely new session instead of resuming the pruned one.
    let reopenedId!: string;
    act(() => {
      reopenedId = result.current.openChatSession("recon", "model-a");
    });
    expect(reopenedId).not.toBe(id);
  });

  it("pruneOrphanedSessions() keeps everything when every agent is still valid", () => {
    const { result } = renderHook(() => useSessions());

    act(() => {
      result.current.openChatSession("recon", "model-a");
      result.current.openTaskSession("planner", "model-a", "proj-1", "go");
    });

    act(() => result.current.pruneOrphanedSessions(new Set(["recon", "planner"])));

    expect(result.current.chatSessions).toHaveLength(1);
    expect(result.current.taskSessions).toHaveLength(1);
  });

  it("persists sessions to sessionStorage on every change", () => {
    const { result } = renderHook(() => useSessions());

    act(() => {
      result.current.openChatSession("planner", "model-a");
    });

    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY)!);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: "chat", agentId: "planner" });
  });
});
