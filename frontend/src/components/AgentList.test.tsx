import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentList } from "./AgentList";
import type { AgentWithStatus } from "../types/agent";

function agent(overrides: Partial<AgentWithStatus> = {}): AgentWithStatus {
  return {
    id: "planner",
    name: "Planner",
    description: "Breaks work into steps",
    model: "qwen2.5-coder:7b",
    systemPrompt: "",
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 0,
    icon: "brain",
    color: "#00e676",
    enabled: true,
    status: "online",
    ...overrides,
  };
}

const baseProps = {
  agents: [] as AgentWithStatus[],
  loading: false,
  error: null as string | null,
  warnings: [] as { file: string; reason: string }[],
  activeAgentIds: new Set<string>(),
  onSelectAgent: vi.fn(),
  onRefresh: vi.fn(),
  onCreateAgent: vi.fn(),
  onEditAgent: vi.fn(),
};

describe("AgentList", () => {
  it("shows a loading skeleton (no list items) when loading with no agents yet", () => {
    render(<AgentList {...baseProps} loading />);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("shows an empty state when there are no agents", () => {
    render(<AgentList {...baseProps} />);
    expect(screen.getByText("No agents found")).toBeInTheDocument();
  });

  it("renders each agent's name, description, and model", () => {
    render(<AgentList {...baseProps} agents={[agent()]} />);
    expect(screen.getByText("Planner")).toBeInTheDocument();
    expect(screen.getByText("Breaks work into steps")).toBeInTheDocument();
    expect(screen.getByText("qwen2.5-coder:7b")).toBeInTheDocument();
  });

  it("calls onSelectAgent with the clicked agent", async () => {
    const onSelectAgent = vi.fn();
    const a = agent();
    render(<AgentList {...baseProps} agents={[a]} onSelectAgent={onSelectAgent} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("Planner"));
    expect(onSelectAgent).toHaveBeenCalledWith(a);
  });

  it("lists every config warning with its file and reason", () => {
    render(
      <AgentList
        {...baseProps}
        warnings={[
          { file: "bad.json", reason: "invalid JSON" },
          { file: "dup.json", reason: "duplicate id" },
        ]}
      />,
    );
    expect(screen.getByText(/2 agent config files failed to load/)).toBeInTheDocument();
    expect(screen.getByText("bad.json")).toBeInTheDocument();
    expect(screen.getByText(/invalid JSON/)).toBeInTheDocument();
    expect(screen.getByText("dup.json")).toBeInTheDocument();
  });

  it("uses singular phrasing for exactly one warning", () => {
    render(<AgentList {...baseProps} warnings={[{ file: "bad.json", reason: "invalid JSON" }]} />);
    expect(screen.getByText(/1 agent config file failed to load/)).toBeInTheDocument();
  });

  it("calls onRefresh from the reload button", async () => {
    const onRefresh = vi.fn();
    render(<AgentList {...baseProps} onRefresh={onRefresh} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Reload agent configs" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("shows the top-level error message", () => {
    render(<AgentList {...baseProps} error="Failed to load agents" />);
    expect(screen.getByText("Failed to load agents")).toBeInTheDocument();
  });

  it("calls onCreateAgent from the new-agent button", async () => {
    const onCreateAgent = vi.fn();
    render(<AgentList {...baseProps} onCreateAgent={onCreateAgent} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New agent" }));
    expect(onCreateAgent).toHaveBeenCalledTimes(1);
  });

  it("calls onEditAgent from the per-agent edit button", async () => {
    const onEditAgent = vi.fn();
    const a = agent();
    render(<AgentList {...baseProps} agents={[a]} onEditAgent={onEditAgent} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Edit Planner" }));
    expect(onEditAgent).toHaveBeenCalledWith(a);
  });
});
