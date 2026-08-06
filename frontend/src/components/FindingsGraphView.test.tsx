import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
    const { container } = render(<FindingsGraphView projectId="proj-1" onSelectFindingId={vi.fn()} />);

    await waitFor(() => expect(container.querySelectorAll("circle")).toHaveLength(3));
    expect(mockFetchFindingsGraph).toHaveBeenCalledWith("proj-1");
  });

  it("shows an empty state when the graph has no nodes", async () => {
    mockFetchFindingsGraph.mockResolvedValue({ nodes: [], edges: [] });
    render(<FindingsGraphView projectId="proj-1" onSelectFindingId={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/No findings yet to graph/)).toBeInTheDocument());
  });

  it("surfaces a load failure", async () => {
    mockFetchFindingsGraph.mockRejectedValue(new Error("boom"));
    render(<FindingsGraphView projectId="proj-1" onSelectFindingId={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
  });

  it("refetches when projectId changes", async () => {
    mockFetchFindingsGraph.mockResolvedValue(fixtureGraph);
    const { rerender } = render(<FindingsGraphView projectId="proj-1" onSelectFindingId={vi.fn()} />);
    await waitFor(() => expect(mockFetchFindingsGraph).toHaveBeenCalledWith("proj-1"));

    rerender(<FindingsGraphView projectId="proj-2" onSelectFindingId={vi.fn()} />);
    await waitFor(() => expect(mockFetchFindingsGraph).toHaveBeenCalledWith("proj-2"));
  });
});
