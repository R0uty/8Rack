import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FindingsGraphView } from "./FindingsGraphView";
import { fetchFindingsGraph } from "../services/findingsApi";
import type { FindingsGraph } from "../types/finding";

vi.mock("../services/findingsApi", () => ({ fetchFindingsGraph: vi.fn() }));

const mockFetchFindingsGraph = vi.mocked(fetchFindingsGraph);

const fixtureGraph: FindingsGraph = {
  nodes: [
    { id: "target:example.com", type: "target", label: "example.com" },
    { id: "finding-1", type: "port", label: "Port 80/tcp open" },
    { id: "tool:nmap", type: "tool", label: "nmap" },
  ],
  edges: [
    { source: "target:example.com", target: "finding-1", relation: "runs_on" },
    { source: "finding-1", target: "tool:nmap", relation: "discovered_by" },
  ],
};

describe("FindingsGraphView", () => {
  it("shows a loading state, then renders one node per graph node", async () => {
    mockFetchFindingsGraph.mockResolvedValue(fixtureGraph);
    const { container } = render(<FindingsGraphView missionId="proj-1" onSelectFindingId={vi.fn()} />);

    await waitFor(() => expect(container.querySelectorAll("circle")).toHaveLength(3));
    expect(mockFetchFindingsGraph).toHaveBeenCalledWith("proj-1");
  });

  it("shows an empty state when the graph has no nodes", async () => {
    mockFetchFindingsGraph.mockResolvedValue({ nodes: [], edges: [] });
    render(<FindingsGraphView missionId="proj-1" onSelectFindingId={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/No findings yet to graph/)).toBeInTheDocument());
  });

  it("surfaces a load failure", async () => {
    mockFetchFindingsGraph.mockRejectedValue(new Error("boom"));
    render(<FindingsGraphView missionId="proj-1" onSelectFindingId={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
  });

  it("refetches when missionId changes", async () => {
    mockFetchFindingsGraph.mockResolvedValue(fixtureGraph);
    const { rerender } = render(<FindingsGraphView missionId="proj-1" onSelectFindingId={vi.fn()} />);
    await waitFor(() => expect(mockFetchFindingsGraph).toHaveBeenCalledWith("proj-1"));

    rerender(<FindingsGraphView missionId="proj-2" onSelectFindingId={vi.fn()} />);
    await waitFor(() => expect(mockFetchFindingsGraph).toHaveBeenCalledWith("proj-2"));
  });

  it("dims a finding node excluded from visibleFindingIds, and shows the match count", async () => {
    mockFetchFindingsGraph.mockResolvedValue(fixtureGraph);
    const { container } = render(
      <FindingsGraphView missionId="proj-1" onSelectFindingId={vi.fn()} visibleFindingIds={new Set(["finding-1"])} />,
    );
    await waitFor(() => expect(container.querySelectorAll("circle")).toHaveLength(3));

    const nodeGroups = container.querySelectorAll("g[transform^='translate']");
    const dimmed = [...nodeGroups].filter((g) => (g as SVGGElement).style.opacity === "0.2");
    // Only the target/tool structural nodes and the matching finding stay at full opacity - a
    // filtered-out finding node (there are none in this fixture besides finding-1, which matches)
    // would be the one dimmed; assert none are here since finding-1 is the only finding node and
    // it's in the visible set.
    expect(dimmed).toHaveLength(0);
    expect(screen.getByText(/1 matching filter/)).toBeInTheDocument();
  });

  it("dims a finding node not in visibleFindingIds when another finding is the only match", async () => {
    const twoFindingGraph = {
      nodes: [...fixtureGraph.nodes, { id: "finding-2", type: "cve" as const, label: "CVE-2024-0001" }],
      edges: fixtureGraph.edges,
    };
    mockFetchFindingsGraph.mockResolvedValue(twoFindingGraph);
    const { container } = render(
      <FindingsGraphView missionId="proj-1" onSelectFindingId={vi.fn()} visibleFindingIds={new Set(["finding-1"])} />,
    );
    await waitFor(() => expect(container.querySelectorAll("circle")).toHaveLength(4));

    const nodeGroups = [...container.querySelectorAll("g[transform^='translate']")];
    const dimmed = nodeGroups.filter((g) => (g as SVGGElement).style.opacity === "0.2");
    expect(dimmed).toHaveLength(1);
  });

  it("selects a finding node via keyboard (Enter)", async () => {
    mockFetchFindingsGraph.mockResolvedValue(fixtureGraph);
    const onSelectFindingId = vi.fn();
    render(<FindingsGraphView missionId="proj-1" onSelectFindingId={onSelectFindingId} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Port 80/tcp open" })).toBeInTheDocument());

    const node = screen.getByRole("button", { name: "Port 80/tcp open" });
    node.focus();
    await userEvent.keyboard("{Enter}");

    expect(onSelectFindingId).toHaveBeenCalledWith("finding-1");
  });

  it("only makes finding-type nodes keyboard-focusable, not target/tool structural nodes", async () => {
    mockFetchFindingsGraph.mockResolvedValue(fixtureGraph);
    render(<FindingsGraphView missionId="proj-1" onSelectFindingId={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Port 80/tcp open" })).toBeInTheDocument());

    expect(screen.queryByRole("button", { name: "example.com" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "nmap" })).not.toBeInTheDocument();
  });
});
