import { describe, expect, it } from "vitest";
import { computeLayout } from "./graphLayout";
import type { FindingsGraphEdge, FindingsGraphNode } from "../types/finding";

function node(id: string, type: FindingsGraphNode["type"] = "target"): FindingsGraphNode {
  return { id, type, label: id };
}

describe("computeLayout", () => {
  it("returns an empty map for an empty graph", () => {
    expect(computeLayout([], [], 800, 600).size).toBe(0);
  });

  it("places a single node with no edges at the center", () => {
    const positions = computeLayout([node("a")], [], 800, 600);
    expect(positions.get("a")).toEqual({ x: 400, y: 300 });
  });

  it("returns one finite-coordinate entry per node", () => {
    const nodes = [node("a"), node("b"), node("c", "port"), node("d", "service")];
    const edges: FindingsGraphEdge[] = [
      { source: "a", target: "b", relation: "runs_on" },
      { source: "b", target: "c", relation: "uses" },
      { source: "a", target: "d", relation: "contains" },
    ];

    const positions = computeLayout(nodes, edges, 800, 600);

    expect(positions.size).toBe(4);
    for (const id of ["a", "b", "c", "d"]) {
      const p = positions.get(id);
      expect(p).toBeDefined();
      expect(Number.isFinite(p!.x)).toBe(true);
      expect(Number.isFinite(p!.y)).toBe(true);
    }
  });

  it("spreads nodes apart rather than stacking them all on one point", () => {
    const nodes = Array.from({ length: 6 }, (_, i) => node(`n${i}`));
    const positions = computeLayout(nodes, [], 800, 600);

    const coords = [...positions.values()];
    const distinct = new Set(coords.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it("keeps linked nodes closer together than the collide radius allows for unrelated nodes", () => {
    const nodes = [node("hub"), node("linked"), node("far")];
    const edges: FindingsGraphEdge[] = [{ source: "hub", target: "linked", relation: "uses" }];
    const positions = computeLayout(nodes, edges, 800, 600);

    const dist = (a: string, b: string) => {
      const pa = positions.get(a)!;
      const pb = positions.get(b)!;
      return Math.hypot(pa.x - pb.x, pa.y - pb.y);
    };

    expect(dist("hub", "linked")).toBeLessThan(dist("hub", "far"));
  });
});
