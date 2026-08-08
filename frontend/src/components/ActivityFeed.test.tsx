import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ActivityFeed } from "./ActivityFeed";
import type { ExecutionRecord } from "../types/execTool";
import type { OrchestratorTask } from "../types/orchestrator";
import type { AgentWithStatus } from "../types/agent";

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

function fixtureExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: "exec-1",
    toolId: "nmap",
    arguments: ["-sV", "example.com"],
    resolvedCommand: "nmap -sV example.com",
    cwd: "/",
    status: "completed",
    createdAt: 2000,
    ...overrides,
  };
}

function fixtureTask(overrides: Partial<OrchestratorTask> = {}): OrchestratorTask {
  return {
    id: "task-1",
    agentId: "recon-agent",
    objective: "enumerate subdomains",
    messages: [],
    status: "completed",
    toolExecutionIds: [],
    toolCallCount: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe("ActivityFeed", () => {
  it("shows an empty state with no executions or tasks", () => {
    render(<ActivityFeed executions={[]} tasks={[]} agents={[]} loading={false} error={null} />);
    expect(screen.getByText(/No activity yet/)).toBeInTheDocument();
  });

  it("shows the error message instead of the feed when error is set", () => {
    render(<ActivityFeed executions={[]} tasks={[]} agents={[]} loading={false} error="boom" />);
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("renders both executions and tasks, newest first", () => {
    render(
      <ActivityFeed
        executions={[fixtureExecution({ createdAt: 1000 })]}
        tasks={[fixtureTask({ createdAt: 2000, objective: "enumerate subdomains" })]}
        agents={[fixtureAgent()]}
        loading={false}
        error={null}
      />,
    );

    const rows = screen.getAllByText(/enumerate subdomains|nmap -sV example\.com/);
    expect(rows[0]).toHaveTextContent("enumerate subdomains");
    expect(rows[1]).toHaveTextContent("nmap -sV example.com");
  });

  it("resolves an execution's agentId to the agent's name", () => {
    render(
      <ActivityFeed
        executions={[fixtureExecution({ agentId: "recon-agent" })]}
        tasks={[]}
        agents={[fixtureAgent()]}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByText("Recon Agent")).toBeInTheDocument();
  });

  it("shows an error indicator for a failed task, with the error as a tooltip", () => {
    render(
      <ActivityFeed
        executions={[]}
        tasks={[fixtureTask({ status: "failed", error: "model unreachable" })]}
        agents={[fixtureAgent()]}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByTitle("model unreachable")).toBeInTheDocument();
  });
});
