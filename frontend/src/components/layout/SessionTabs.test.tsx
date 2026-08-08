import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Compass } from "lucide-react";
import { SessionTabs } from "./SessionTabs";
import type { SessionMeta } from "../../hooks/useSessions";
import type { AgentWithStatus } from "../../types/agent";
import type { Project } from "../../types/project";

function fixtureAgent(overrides: Partial<AgentWithStatus> = {}): AgentWithStatus {
  return {
    id: "recon-agent",
    name: "Recon Agent",
    description: "",
    model: "m",
    systemPrompt: "",
    temperature: 0.5,
    topP: 0.9,
    maxTokens: 0,
    icon: "",
    color: "#00ff00",
    enabled: true,
    status: "online",
    ...overrides,
  };
}

function fixtureSession(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "s1",
    kind: "chat",
    agentId: "recon-agent",
    model: "m",
    createdAt: 0,
    ...overrides,
  };
}

const fixtureProject: Project = { id: "proj-a", name: "Acme Corp", notes: "", createdAt: 0 };

function renderTabs(sessions: SessionMeta[], projects: Project[] = []) {
  return render(
    <SessionTabs
      sessions={sessions}
      activeId={null}
      onSelect={vi.fn()}
      onClose={vi.fn()}
      agents={[fixtureAgent()]}
      projects={projects}
      statuses={{}}
      homeIcon={Compass}
      homeLabel="Command Center"
    />,
  );
}

describe("SessionTabs", () => {
  it("labels a plain (no-project) chat session with just the agent name", () => {
    renderTabs([fixtureSession()]);
    expect(screen.getByTitle("Recon Agent")).toBeInTheDocument();
  });

  it("labels a project-scoped chat session with the agent and project name", () => {
    renderTabs([fixtureSession({ projectId: "proj-a" })], [fixtureProject]);
    expect(screen.getByTitle("Recon Agent · Acme Corp")).toBeInTheDocument();
  });

  it("falls back to just the agent name if the session's project can't be resolved", () => {
    renderTabs([fixtureSession({ projectId: "gone" })], [fixtureProject]);
    expect(screen.getByTitle("Recon Agent")).toBeInTheDocument();
  });

  it("still prioritizes a task session's objective over any project name", () => {
    renderTabs(
      [fixtureSession({ kind: "task", projectId: "proj-a", initialObjective: "run nmap" })],
      [fixtureProject],
    );
    expect(screen.getByTitle("Recon Agent: run nmap")).toBeInTheDocument();
  });

  it("labels a manual (no-agent) session as 'Manual chat', with a project suffix if scoped", () => {
    renderTabs([fixtureSession({ agentId: null, projectId: "proj-a" })], [fixtureProject]);
    expect(screen.getByTitle("Manual chat · Acme Corp")).toBeInTheDocument();
  });

  it("defaults projects to an empty list when the prop is omitted (Workbench's task tabs don't pass one)", () => {
    render(
      <SessionTabs
        sessions={[fixtureSession({ kind: "task", initialObjective: "go" })]}
        activeId={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        agents={[fixtureAgent()]}
        statuses={{}}
        homeIcon={Compass}
        homeLabel="New Task"
      />,
    );
    expect(screen.getByTitle("Recon Agent: go")).toBeInTheDocument();
  });
});
