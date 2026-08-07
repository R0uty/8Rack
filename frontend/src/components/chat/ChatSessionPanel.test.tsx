import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatSessionPanel } from "./ChatSessionPanel";
import { useChat } from "../../hooks/useChat";
import type { SessionMeta } from "../../hooks/useSessions";
import type { ChatMessage } from "../../types/chat";

vi.mock("../../hooks/useChat");
vi.mock("./ChatTaskPanel", () => ({
  ChatTaskPanel: () => <div data-testid="chat-task-panel" />,
}));

// jsdom doesn't implement scrollIntoView - the no-project branch renders the real ChatArea, whose
// autoscroll effect calls it on every message list change.
Element.prototype.scrollIntoView = vi.fn();

const mockUseChat = vi.mocked(useChat);

function fixtureMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: "m1", role: "user", content: "hello", createdAt: 0, ...overrides };
}

function fixtureSession(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "session-1",
    kind: "chat",
    agentId: "recon-agent",
    model: "test-model",
    createdAt: 0,
    ...overrides,
  };
}

function renderPanel(session: SessionMeta) {
  return render(
    <ChatSessionPanel
      session={session}
      settings={{
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 0,
        contextSize: 0,
        keepAlive: "5m",
      }}
      models={[{ name: "test-model", model: "test-model", modified_at: "", size: 0, digest: "", details: {} as never }]}
      agentDefaultModel="test-model"
      agentName="Recon Agent"
      projects={[{ id: "proj-1", name: "Project One", notes: "", createdAt: 0 }]}
      onChangeModel={vi.fn()}
      onChangeProject={vi.fn()}
      onChangeTaskId={vi.fn()}
      reportStatus={vi.fn()}
    />,
  );
}

describe("ChatSessionPanel - tool-enabled mid-conversation notice", () => {
  it("shows no notice for a plain (no-project) session", () => {
    mockUseChat.mockReturnValue({
      messages: [fixtureMessage()],
      sending: false,
      sendMessage: vi.fn(),
      cancel: vi.fn(),
      clear: vi.fn(),
    });
    renderPanel(fixtureSession({ projectId: undefined }));
    expect(screen.queryByText(/starts a fresh tool-enabled thread/)).not.toBeInTheDocument();
  });

  it("shows no notice when a project is set but there's no prior plain-chat history", () => {
    mockUseChat.mockReturnValue({ messages: [], sending: false, sendMessage: vi.fn(), cancel: vi.fn(), clear: vi.fn() });
    renderPanel(fixtureSession({ projectId: "proj-1" }));
    expect(screen.queryByText(/starts a fresh tool-enabled thread/)).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-task-panel")).toBeInTheDocument();
  });

  it("warns that prior plain-chat messages are hidden and out of context once a project is set", () => {
    mockUseChat.mockReturnValue({
      messages: [fixtureMessage({ id: "m1" }), fixtureMessage({ id: "m2" })],
      sending: false,
      sendMessage: vi.fn(),
      cancel: vi.fn(),
      clear: vi.fn(),
    });
    renderPanel(fixtureSession({ projectId: "proj-1" }));

    expect(screen.getByText(/starts a fresh tool-enabled thread/)).toBeInTheDocument();
    expect(screen.getByText(/2 earlier messages/)).toBeInTheDocument();
    expect(screen.getByText(/Recon Agent/)).toBeInTheDocument();
    expect(screen.getByTestId("chat-task-panel")).toBeInTheDocument();
  });

  it("uses singular phrasing for exactly one earlier message", () => {
    mockUseChat.mockReturnValue({
      messages: [fixtureMessage()],
      sending: false,
      sendMessage: vi.fn(),
      cancel: vi.fn(),
      clear: vi.fn(),
    });
    renderPanel(fixtureSession({ projectId: "proj-1" }));
    expect(screen.getByText(/1 earlier message\b/)).toBeInTheDocument();
  });
});
