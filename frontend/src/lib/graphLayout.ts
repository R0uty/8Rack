import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import type { FindingsGraphEdge, FindingsGraphNode } from "../types/finding";

interface LayoutNode extends SimulationNodeDatum {
  id: string;
}

/** How many synchronous simulation.tick() calls to run before treating the layout as settled -
 * chosen empirically (d3-force examples commonly use ~300) to be well past the point where alpha
 * has decayed enough that further ticks barely move nodes. */
const TICK_BUDGET = 300;

/**
 * Pre-computes a static force-directed layout for the Findings graph. Runs synchronously (no live
 * tick->render->tick animation loop) - this is a "browse the correlation graph" feature, not one
 * that needs an organic unfolding animation, so settling once up front keeps the component simple
 * and avoids unnecessary re-renders. Returns a plain id->{x,y} map; no d3 objects leak out, so
 * nothing downstream needs to know d3 was involved.
 */
export function computeLayout(
  nodes: FindingsGraphNode[],
  edges: FindingsGraphEdge[],
  width: number,
  height: number,
): Map<string, { x: number; y: number }> {
  const simNodes: LayoutNode[] = nodes.map((n) => ({ id: n.id }));
  const simLinks: SimulationLinkDatum<LayoutNode>[] = edges.map((e) => ({ source: e.source, target: e.target }));

  // .stop() immediately - forceSimulation() otherwise starts its own internal requestAnimationFrame
  // timer; manual synchronous ticking below is what makes this a pure, testable function.
  const simulation = forceSimulation(simNodes)
    .force(
      "link",
      forceLink<LayoutNode, SimulationLinkDatum<LayoutNode>>(simLinks)
        .id((d) => d.id)
        .distance(70),
    )
    .force("charge", forceManyBody().strength(-160))
    .force("center", forceCenter(width / 2, height / 2))
    .force("collide", forceCollide(28))
    .stop();

  for (let i = 0; i < TICK_BUDGET; i++) simulation.tick();

  const positions = new Map<string, { x: number; y: number }>();
  for (const node of simNodes) {
    positions.set(node.id, { x: node.x ?? width / 2, y: node.y ?? height / 2 });
  }
  return positions;
}
