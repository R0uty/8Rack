import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FindingsTable } from "./FindingsTable";
import type { Finding } from "../types/finding";

function fixtureFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "finding-1",
    projectId: "proj-1",
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
    evidence: "",
    tags: [],
    status: "discovered",
    history: [],
    sourceCount: 1,
    firstSeenAt: 0,
    lastSeenAt: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("FindingsTable", () => {
  it("shows an empty state when there are no findings", () => {
    render(<FindingsTable findings={[]} onSelectFinding={vi.fn()} />);
    expect(screen.getByText(/No findings match/)).toBeInTheDocument();
  });

  it("renders a row per finding with severity, type, title, target, tool, and confidence", () => {
    render(<FindingsTable findings={[fixtureFinding()]} onSelectFinding={vi.fn()} />);
    expect(screen.getByText("info")).toBeInTheDocument();
    expect(screen.getByText("port")).toBeInTheDocument();
    expect(screen.getByText("Port 80/tcp open")).toBeInTheDocument();
    expect(screen.getByText("example.com")).toBeInTheDocument();
    expect(screen.getByText("nmap")).toBeInTheDocument();
    expect(screen.getByText("90%")).toBeInTheDocument();
  });

  it("calls onSelectFinding with the clicked finding", async () => {
    const onSelectFinding = vi.fn();
    const finding = fixtureFinding();
    render(<FindingsTable findings={[finding]} onSelectFinding={onSelectFinding} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("Port 80/tcp open"));
    expect(onSelectFinding).toHaveBeenCalledWith(finding);
  });

  it("dims dismissed findings", () => {
    render(<FindingsTable findings={[fixtureFinding({ status: "dismissed" })]} onSelectFinding={vi.fn()} />);
    const row = screen.getByText("Port 80/tcp open").closest("tr");
    expect(row?.className).toContain("opacity-50");
  });
});
