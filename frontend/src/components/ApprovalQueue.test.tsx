import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApprovalQueue } from "./ApprovalQueue";
import { confirmExecution, rejectExecution } from "../services/toolsApi";
import type { ExecutionRecord } from "../types/execTool";
import type { AgentWithStatus } from "../types/agent";

vi.mock("../services/toolsApi", () => ({ confirmExecution: vi.fn(), rejectExecution: vi.fn() }));

const mockConfirm = vi.mocked(confirmExecution);
const mockReject = vi.mocked(rejectExecution);

function fixtureExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: "exec-1",
    toolId: "nmap",
    agentId: "recon-agent",
    arguments: ["-sV", "example.com"],
    resolvedCommand: "nmap -sV example.com",
    cwd: "/",
    status: "pending_confirmation",
    createdAt: 1,
    ...overrides,
  };
}

const agents: AgentWithStatus[] = [
  {
    id: "recon-agent",
    name: "Recon Agent",
    description: "",
    model: "m",
    systemPrompt: "",
    temperature: 0.5,
    topP: 0.9,
    maxTokens: 0,
    icon: "",
    color: "",
    enabled: true,
    status: "online",
  },
];

describe("ApprovalQueue", () => {
  it("renders nothing when nothing is pending", () => {
    const { container } = render(<ApprovalQueue missionName="Acme" executions={[]} agents={agents} onSettled={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("ignores executions that aren't pending_confirmation", () => {
    const { container } = render(
      <ApprovalQueue
        missionName="Acme"
        executions={[fixtureExecution({ status: "completed" })]}
        agents={agents}
        onSettled={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the resolved command, agent name, and scope status, and approves on click", async () => {
    const onSettled = vi.fn();
    mockConfirm.mockResolvedValue(fixtureExecution({ status: "completed" }));
    render(
      <ApprovalQueue missionName="Acme" executions={[fixtureExecution()]} agents={agents} onSettled={onSettled} />,
    );

    expect(screen.getByText("Recon Agent")).toBeInTheDocument();
    expect(screen.getByText("$ nmap -sV example.com")).toBeInTheDocument();
    expect(screen.getByText("No scope warning")).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(mockConfirm).toHaveBeenCalledWith("exec-1", expect.any(Function));
  });

  it("shows the scope warning instead of the all-clear when one is present", () => {
    render(
      <ApprovalQueue
        missionName="Acme"
        executions={[fixtureExecution({ scopeWarning: "no identifiable target" })]}
        agents={agents}
        onSettled={vi.fn()}
      />,
    );
    expect(screen.getByText("no identifiable target")).toBeInTheDocument();
    expect(screen.queryByText("No scope warning")).not.toBeInTheDocument();
  });

  it("rejects on click", async () => {
    const onSettled = vi.fn();
    mockReject.mockResolvedValue(fixtureExecution({ status: "rejected" }));
    render(
      <ApprovalQueue missionName="Acme" executions={[fixtureExecution()]} agents={agents} onSettled={onSettled} />,
    );

    await userEvent.setup().click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(mockReject).toHaveBeenCalledWith("exec-1");
  });
});
