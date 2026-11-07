import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentsView } from "./AgentsView";
import type { AgentWithStatus } from "../types/agent";

const agent: AgentWithStatus = {
  id: "recon-agent",
  name: "Recon Agent",
  description: "Finds assets",
  model: "test-model",
  systemPrompt: "",
  temperature: 0.5,
  topP: 0.9,
  maxTokens: 0,
  icon: "🔭",
  color: "#7aa2f7",
  enabled: true,
  execTools: ["nmap"],
  status: "online",
};

describe("AgentsView", () => {
  it("shows an empty state when there are no agents", () => {
    render(
      <AgentsView agents={[]} loading={false} error={null} warnings={[]} execTools={[]} onRefresh={vi.fn()} onCreateAgent={vi.fn()} onEditAgent={vi.fn()} />,
    );
    expect(screen.getByText("No agents found.")).toBeInTheDocument();
  });

  it("renders each agent's name, description, model, and calls onEditAgent from its Edit button", async () => {
    const onEditAgent = vi.fn();
    render(
      <AgentsView
        agents={[agent]}
        loading={false}
        error={null}
        warnings={[]}
        execTools={[]}
        onRefresh={vi.fn()}
        onCreateAgent={vi.fn()}
        onEditAgent={onEditAgent}
      />,
    );

    expect(screen.getByText("Recon Agent")).toBeInTheDocument();
    expect(screen.getByText("Finds assets")).toBeInTheDocument();
    expect(screen.getByText("test-model")).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: "Edit" }));
    expect(onEditAgent).toHaveBeenCalledWith(agent);
  });

  it("calls onCreateAgent from the New agent button", async () => {
    const onCreateAgent = vi.fn();
    render(
      <AgentsView agents={[]} loading={false} error={null} warnings={[]} execTools={[]} onRefresh={vi.fn()} onCreateAgent={onCreateAgent} onEditAgent={vi.fn()} />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "New agent" }));
    expect(onCreateAgent).toHaveBeenCalled();
  });
});
