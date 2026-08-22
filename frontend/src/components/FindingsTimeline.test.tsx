import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FindingsTimeline } from "./FindingsTimeline";
import type { Finding } from "../types/finding";

const now = Date.now();

function fixtureFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "finding-1",
    missionId: "proj-1",
    type: "port",
    severity: "info",
    title: "Port 80/tcp open",
    description: "",
    source: "scanner",
    tool: "nmap",
    confidence: 0.9,
    target: "example.com",
    value: "80/tcp",
    metadata: {},
    evidence: [],
    tags: [],
    status: "confirmed",
    history: [
      { status: "potential", at: now - 60_000 },
      { status: "confirmed", at: now },
    ],
    sourceCount: 1,
    executionIds: [],
    relatedAgents: [],
    firstSeenAt: now - 60_000,
    lastSeenAt: now,
    createdAt: now - 60_000,
    updatedAt: now,
    ...overrides,
  };
}

describe("FindingsTimeline", () => {
  it("shows an empty state when there are no events", () => {
    render(<FindingsTimeline findings={[]} onSelectFinding={vi.fn()} />);
    expect(screen.getByText("No timeline events yet.")).toBeInTheDocument();
  });

  it("flattens every finding's history into a newest-first list under a Today group", () => {
    render(<FindingsTimeline findings={[fixtureFinding()]} onSelectFinding={vi.fn()} />);
    expect(screen.getByText("Today")).toBeInTheDocument();
    const rows = screen.getAllByRole("button").filter((b) => b.textContent?.includes("Port 80/tcp open"));
    expect(rows).toHaveLength(2);
    // Newest event ("Confirmed") should render before the older one ("Potential").
    expect(rows[0].textContent).toContain("Confirmed");
    expect(rows[1].textContent).toContain("Potential");
  });

  it("filters by event type", async () => {
    render(<FindingsTimeline findings={[fixtureFinding()]} onSelectFinding={vi.fn()} />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole("combobox"), "confirmed");

    const rows = screen.getAllByRole("button").filter((b) => b.textContent?.includes("Port 80/tcp open"));
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Confirmed");
  });

  it("calls onSelectFinding when a row is clicked", async () => {
    const onSelectFinding = vi.fn();
    const finding = fixtureFinding();
    render(<FindingsTimeline findings={[finding]} onSelectFinding={onSelectFinding} />);
    const user = userEvent.setup();
    await user.click(screen.getAllByText("Port 80/tcp open")[0]);
    expect(onSelectFinding).toHaveBeenCalledWith(finding);
  });
});
