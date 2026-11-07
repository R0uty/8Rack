import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FindingDetails } from "./FindingDetails";
import { lookupCves } from "../services/findingsApi";
import { streamChat } from "../services/chatApi";
import type { Finding } from "../types/finding";

vi.mock("../services/findingsApi", () => ({ lookupCves: vi.fn() }));
vi.mock("../services/chatApi", () => ({ streamChat: vi.fn() }));

function fixtureFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "finding-1",
    missionId: "proj-1",
    type: "potential_vulnerability",
    severity: "high",
    title: "Reflected XSS in search",
    description: "The q parameter is reflected unescaped.",
    source: "agent",
    tool: "recon-agent",
    confidence: 0.8,
    target: "example.com",
    value: "/search?q",
    metadata: {},
    evidence: [],
    tags: [],
    status: "potential",
    history: [],
    sourceCount: 1,
    executionIds: [],
    relatedAgents: [],
    firstSeenAt: 0,
    lastSeenAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function setup(overrides: Partial<React.ComponentProps<typeof FindingDetails>> = {}) {
  const onClose = vi.fn();
  const onUpdate = vi.fn().mockResolvedValue(fixtureFinding());
  const onSelectRelated = vi.fn();
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  const props = {
    finding: fixtureFinding(),
    findings: [],
    onClose,
    onUpdate,
    onSelectRelated,
    onRefresh,
    ...overrides,
  };
  render(<FindingDetails {...props} />);
  return { onClose, onUpdate, onSelectRelated, onRefresh };
}

describe("FindingDetails", () => {
  it("renders nothing (an empty sheet) when finding is null", () => {
    setup({ finding: null });
    expect(screen.queryByText("Reflected XSS in search")).not.toBeInTheDocument();
  });

  it("shows the current status as a pill using the new vocabulary", () => {
    setup({ finding: fixtureFinding({ status: "investigating" }) });
    // "Investigating" also appears as one of the status buttons below the pill.
    expect(screen.getAllByText("Investigating").length).toBeGreaterThanOrEqual(2);
  });

  it("clicking a status button calls onUpdate with that status, and the current status is disabled", async () => {
    const { onUpdate } = setup({ finding: fixtureFinding({ status: "potential" }) });
    const user = userEvent.setup();

    expect(screen.getByRole("button", { name: "Potential" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Confirmed" }));

    expect(onUpdate).toHaveBeenCalledWith("finding-1", { status: "confirmed" });
  });

  it("pre-fills parameter/impact/reproductionSteps from the finding", () => {
    setup({
      finding: fixtureFinding({
        parameter: "q",
        impact: "Session hijack",
        reproductionSteps: "1. Do X\n2. Observe Y",
      }),
    });
    expect(screen.getByLabelText("Parameter")).toHaveValue("q");
    expect(screen.getByLabelText("Impact")).toHaveValue("Session hijack");
    expect(screen.getByLabelText("Reproduction Steps")).toHaveValue("1. Do X\n2. Observe Y");
  });

  it("Save details is disabled until a detail field is edited, then calls onUpdate with the patch", async () => {
    const { onUpdate } = setup({ finding: fixtureFinding({ parameter: "" }) });
    const user = userEvent.setup();

    const saveButton = screen.getByRole("button", { name: "Save details" });
    expect(saveButton).toBeDisabled();

    await user.type(screen.getByPlaceholderText("e.g. id, redirect_url"), "id");
    expect(saveButton).toBeEnabled();

    await user.click(saveButton);
    expect(onUpdate).toHaveBeenCalledWith("finding-1", { parameter: "id", impact: "", reproductionSteps: "" });
  });

  it("renders each evidence item with its type label, newest first", () => {
    setup({
      finding: fixtureFinding({
        evidence: [
          { id: "ev-1", type: "tool_result", content: "first", createdAt: 0 },
          { id: "ev-2", type: "agent_reasoning", content: "second", createdAt: 1 },
        ],
      }),
    });

    expect(screen.getByText("Tool Result")).toBeInTheDocument();
    expect(screen.getByText("Agent Reasoning")).toBeInTheDocument();
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();
  });

  it("shows related agents and a related-executions count when present", () => {
    // "recon-agent" is also this fixture's `tool` (shown as "Source Tool"), so it legitimately
    // appears twice - once there, once in the Related Agents badge list.
    setup({ finding: fixtureFinding({ relatedAgents: ["recon-agent", "validator-agent"], executionIds: ["e1", "e2", "e3"] }) });

    expect(screen.getAllByText("recon-agent").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("validator-agent")).toBeInTheDocument();
    expect(screen.getByText("3 tool executions")).toBeInTheDocument();
  });

  it("omits the related agents/executions section entirely when both are empty", () => {
    setup({ finding: fixtureFinding({ relatedAgents: [], executionIds: [] }) });
    expect(screen.queryByText("Related Agents")).not.toBeInTheDocument();
  });
});

describe("FindingDetails CVE lookup and AI explanation (pre-existing, unchanged behavior)", () => {
  it("shows the CVE lookup button only for technology findings", () => {
    setup({ finding: fixtureFinding({ type: "technology" }) });
    expect(screen.getByRole("button", { name: /Check for CVEs/ })).toBeInTheDocument();
  });

  it("does not show the CVE lookup button for a non-technology finding", () => {
    setup({ finding: fixtureFinding({ type: "potential_vulnerability" }) });
    expect(screen.queryByRole("button", { name: /Check for CVEs/ })).not.toBeInTheDocument();
  });

  it("calls lookupCves and onRefresh when the CVE button is clicked", async () => {
    vi.mocked(lookupCves).mockResolvedValue([]);
    const { onRefresh } = setup({ finding: fixtureFinding({ type: "technology" }) });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /Check for CVEs/ }));

    expect(lookupCves).toHaveBeenCalledWith("finding-1");
    expect(onRefresh).toHaveBeenCalled();
    expect(await screen.findByText("No CVEs found.")).toBeInTheDocument();
  });

  it("streams an AI explanation when 'Explain with AI' is clicked", async () => {
    vi.mocked(streamChat).mockImplementation(async (_req, onEvent) => {
      onEvent({ role: "assistant", content: "This looks like a real vulnerability.", done: true });
    });
    setup();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Explain with AI" }));

    expect(await screen.findByText("This looks like a real vulnerability.")).toBeInTheDocument();
  });
});
