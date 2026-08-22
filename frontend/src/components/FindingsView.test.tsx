import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FindingsView } from "./FindingsView";
import { useMissions } from "../hooks/useMissions";
import { useFindings } from "../hooks/useFindings";
import type { Finding } from "../types/finding";
import type { Mission } from "../types/mission";

vi.mock("../hooks/useMissions", () => ({ useMissions: vi.fn() }));
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

// The heavy per-mode views aren't this suite's concern (each has its own test file) - stub them
// down to just enough surface to drive FindingsView's own state (mission selection, finding
// selection, view mode switching).
vi.mock("./MissionPanel", () => ({
  MissionPanel: ({ missions, onSelect }: { missions: Mission[]; onSelect: (p: Mission) => void }) => (
    <div>
      {missions.map((p) => (
        <button key={p.id} onClick={() => onSelect(p)}>
          {p.name}
        </button>
      ))}
    </div>
  ),
}));
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
vi.mock("./FindingsTimeline", () => ({ FindingsTimeline: () => null }));
vi.mock("./FindingsGraphView", () => ({ FindingsGraphView: () => null }));
vi.mock("./FindingDetails", () => ({
  FindingDetails: ({ finding }: { finding: Finding | null }) => <div data-testid="drawer">{finding ? finding.title : "none"}</div>,
}));

const mockUseMissions = vi.mocked(useMissions);
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

describe("FindingsView - mission switch clears the details drawer", () => {
  it("does not keep showing a stale finding from the previously selected mission", async () => {
    const user = userEvent.setup();
    mockUseMissions.mockReturnValue({
      missions: [missionA, missionB],
      loading: false,
      error: null,
      refresh: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    });
    mockUseFindings.mockImplementation((missionId) => ({
      findings: missionId === "proj-a" ? [findingA] : missionId === "proj-b" ? [findingB] : [],
      loading: false,
      error: null,
      refresh: vi.fn(),
      create: vi.fn(),
      update: vi.fn(async (_id, patch) => ({ ...findingA, ...patch })),
      remove: vi.fn(),
    }));

    render(<FindingsView />);

    await user.click(screen.getByRole("button", { name: "Mission A" }));
    await user.click(screen.getByRole("button", { name: "Finding A" }));
    expect(screen.getByTestId("drawer")).toHaveTextContent("Finding A");

    // Regression: switching missions previously left selectedFinding pointing at Finding A -
    // findings.find() misses it in Mission B's list and fell back to the stale object instead of
    // clearing the drawer.
    await user.click(screen.getByRole("button", { name: "Mission B" }));

    expect(screen.getByTestId("drawer")).toHaveTextContent("none");
  });
});
