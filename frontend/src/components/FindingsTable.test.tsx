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

function renderTable(
  props: Partial<{
    findings: Finding[];
    onSelectFinding: (f: Finding) => void;
    selectedIds: Set<string>;
    onToggleSelect: (id: string) => void;
    onToggleSelectAll: (ids: string[]) => void;
  }> = {},
) {
  return render(
    <FindingsTable
      findings={props.findings ?? []}
      onSelectFinding={props.onSelectFinding ?? vi.fn()}
      selectedIds={props.selectedIds ?? new Set()}
      onToggleSelect={props.onToggleSelect ?? vi.fn()}
      onToggleSelectAll={props.onToggleSelectAll ?? vi.fn()}
    />,
  );
}

describe("FindingsTable", () => {
  it("shows an empty state when there are no findings", () => {
    renderTable({ findings: [] });
    expect(screen.getByText(/No findings match/)).toBeInTheDocument();
  });

  it("renders a row per finding with severity, type, title, target, tool, and confidence", () => {
    renderTable({ findings: [fixtureFinding()] });
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
    renderTable({ findings: [finding], onSelectFinding });
    const user = userEvent.setup();
    await user.click(screen.getByText("Port 80/tcp open"));
    expect(onSelectFinding).toHaveBeenCalledWith(finding);
  });

  it("dims dismissed findings", () => {
    renderTable({ findings: [fixtureFinding({ status: "dismissed" })] });
    const row = screen.getByText("Port 80/tcp open").closest("tr");
    expect(row?.className).toContain("opacity-50");
  });

  it("checks a row's checkbox according to selectedIds", () => {
    renderTable({ findings: [fixtureFinding()], selectedIds: new Set(["finding-1"]) });
    expect(screen.getByRole("checkbox", { name: /Select finding/ })).toBeChecked();
  });

  it("toggles a single row's selection without opening the details drawer", async () => {
    const onToggleSelect = vi.fn();
    const onSelectFinding = vi.fn();
    renderTable({ findings: [fixtureFinding()], onToggleSelect, onSelectFinding });
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: /Select finding/ }));
    expect(onToggleSelect).toHaveBeenCalledWith("finding-1");
    expect(onSelectFinding).not.toHaveBeenCalled();
  });

  it("select-all checkbox selects every visible finding, and toggles off when all are selected", async () => {
    const findings = [fixtureFinding({ id: "a" }), fixtureFinding({ id: "b", title: "Second finding" })];
    const onToggleSelectAll = vi.fn();
    renderTable({ findings, onToggleSelectAll });
    const user = userEvent.setup();
    const selectAll = screen.getByRole("checkbox", { name: "Select all visible findings" });
    expect(selectAll).not.toBeChecked();
    await user.click(selectAll);
    expect(onToggleSelectAll).toHaveBeenCalledWith(["a", "b"]);
  });

  it("shows the select-all checkbox as checked and labeled to deselect once every visible finding is selected", () => {
    const findings = [fixtureFinding({ id: "a" }), fixtureFinding({ id: "b", title: "Second finding" })];
    renderTable({ findings, selectedIds: new Set(["a", "b"]) });
    expect(screen.getByRole("checkbox", { name: "Deselect all visible findings" })).toBeChecked();
  });
});
