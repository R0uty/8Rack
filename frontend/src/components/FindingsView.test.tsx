import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FindingsView } from "./FindingsView";
import { useFindings } from "../hooks/useFindings";
import type { Finding } from "../types/finding";
import type { Mission } from "../types/mission";

vi.mock("../hooks/useFindings", () => ({ useFindings: vi.fn() }));
vi.mock("../hooks/useReports", () => ({
  useReports: () => ({
    reports: [],
    loading: false,
    generating: false,
    streamingText: "",
    error: null,
    refresh: vi.fn(),
    generate: vi.fn(),
    remove: vi.fn(),
    setStatus: vi.fn(),
  }),
}));

// FindingsTable/FindingDetails have their own test files - stubbed down to just enough surface to
// drive FindingsView's own state.
vi.mock("./FindingsTable", () => ({
  FindingsTable: ({ findings, onSelectFinding }: { findings: Finding[]; onSelectFinding: (f: Finding) => void }) => (
    <div>
      {findings.map((f) => (
        <button key={f.id} onClick={() => onSelectFinding(f)}>
          {f.title}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("./FindingDetails", () => ({
  FindingDetails: ({ finding }: { finding: Finding | null }) => <div data-testid="drawer">{finding ? finding.title : "none"}</div>,
}));

const mockUseFindings = vi.mocked(useFindings);

const missionA: Mission = { id: "proj-a", name: "Mission A", notes: "", createdAt: 1 };
const missionB: Mission = { id: "proj-b", name: "Mission B", notes: "", createdAt: 2 };

function fixtureFinding(overrides: Partial<Finding>): Finding {
  return {
    id: "f-1",
    missionId: "proj-a",
    type: "port",
    severity: "medium",
    title: "Finding",
    description: "",
    source: "scanner",
    tool: "nmap",
    confidence: 0.8,
    target: "example.com",
    value: "80",
    metadata: {},
    evidence: [],
    tags: [],
    status: "potential",
    history: [],
    sourceCount: 1,
    executionIds: [],
    relatedAgents: [],
    firstSeenAt: 1,
    lastSeenAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const findingA = fixtureFinding({ id: "finding-a", missionId: "proj-a", title: "Finding A" });
const findingB = fixtureFinding({ id: "finding-b", missionId: "proj-b", title: "Finding B" });

function setupFindings() {
  mockUseFindings.mockImplementation((missionId) => ({
    findings:
      missionId === "proj-a"
        ? [findingA, fixtureFinding({ id: "finding-c", title: "Finding C", severity: "critical", status: "confirmed", type: "service" })]
        : missionId === "proj-b"
          ? [findingB]
          : [],
    loading: false,
    error: null,
    refresh: vi.fn(),
    create: vi.fn(),
    update: vi.fn(async (_id, patch) => ({ ...findingA, ...patch })),
    remove: vi.fn(),
  }));
}

describe("FindingsView", () => {
  it("does not keep showing a stale finding from the previously selected mission", async () => {
    const user = userEvent.setup();
    setupFindings();

    const { rerender } = render(<FindingsView mission={missionA} />);

    await user.click(screen.getByRole("button", { name: "Finding A" }));
    expect(screen.getByTestId("drawer")).toHaveTextContent("Finding A");

    // Regression: switching missions previously left selectedFinding pointing at Finding A -
    // findings.find() misses it in Mission B's list and fell back to the stale object instead of
    // clearing the drawer.
    rerender(<FindingsView mission={missionB} />);

    expect(screen.getByTestId("drawer")).toHaveTextContent("none");
  });

  it("filters by status, severity, and type together", async () => {
    const user = userEvent.setup();
    setupFindings();
    render(<FindingsView mission={missionA} />);

    await user.selectOptions(screen.getByLabelText("Status"), "confirmed");
    expect(screen.queryByRole("button", { name: "Finding A" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finding C" })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Severity"), "low");
    expect(screen.queryByRole("button", { name: "Finding C" })).not.toBeInTheDocument();
  });

  it("says there are no findings yet, without any filters, on an empty mission", () => {
    setupFindings();
    render(<FindingsView mission={{ ...missionA, id: "empty" }} />);

    expect(screen.getByText(/No findings yet/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Status")).not.toBeInTheDocument();
  });
});
