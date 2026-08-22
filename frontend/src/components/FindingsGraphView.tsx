import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { drag } from "d3-drag";
import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomTransform } from "d3-zoom";
import { Minus, Plus, RefreshCw as ResetIcon } from "lucide-react";
import { computeLayout } from "../lib/graphLayout";
import { fetchFindingsGraph } from "../services/findingsApi";
import { cn } from "../lib/cn";
import { GlassPanel, IconButton, SkeletonRows, type Tone } from "./ui";
import type { FindingsGraph, FindingsGraphEdge, FindingsGraphNode, FindingType } from "../types/finding";

interface FindingsGraphViewProps {
  missionId: string;
  onSelectFindingId: (id: string) => void;
  /** Finding ids that currently match FindingsView's filter bar - `null` means no filter is
   * active (everything shown at full opacity). A finding-type node not in this set is dimmed
   * rather than removed, so the graph's topology (and any tool/target structural nodes) stays
   * visible for context instead of the graph silently going blank or disconnected. */
  visibleFindingIds?: Set<string> | null;
}

const LAYOUT_WIDTH = 900;
const LAYOUT_HEIGHT = 560;

const FINDING_TYPES: readonly FindingType[] = [
  "port",
  "service",
  "technology",
  "domain",
  "subdomain",
  "directory",
  "endpoint",
  "credential",
  "cookie",
  "api",
  "header",
  "interesting_file",
  "potential_vulnerability",
  "confirmed_vulnerability",
  "information",
  "cve",
];

/** Maps every node type onto the app's existing 5-value Tone system (ui/StatusPill.tsx), same
 * technique as AgentNetwork.tsx's TONE_COLOR - many node types collapse onto one of 5 hues rather
 * than inventing a bespoke palette. */
const NODE_TONE: Record<FindingsGraphNode["type"], Tone> = {
  target: "primary",
  domain: "primary",
  subdomain: "primary",
  tool: "neutral",
  information: "neutral",
  port: "info",
  service: "warning",
  technology: "warning",
  directory: "warning",
  endpoint: "warning",
  interesting_file: "warning",
  credential: "critical",
  cookie: "critical",
  api: "critical",
  header: "critical",
  potential_vulnerability: "critical",
  confirmed_vulnerability: "critical",
  cve: "critical",
};

const TONE_COLOR: Record<Tone, string> = {
  primary: "var(--color-primary)",
  info: "var(--color-info)",
  warning: "var(--color-warning)",
  critical: "var(--color-critical)",
  neutral: "var(--color-muted)",
};

const LEGEND: { label: string; tone: Tone }[] = [
  { label: "Target", tone: "primary" },
  { label: "Port", tone: "info" },
  { label: "Service / Tech / Path", tone: "warning" },
  { label: "Vulnerability / CVE / Sensitive", tone: "critical" },
  { label: "Tool / Info", tone: "neutral" },
];

function nodeRadius(type: FindingsGraphNode["type"]): number {
  return type === "target" || type === "tool" ? 11 : 7;
}

export function FindingsGraphView({ missionId, onSelectFindingId, visibleFindingIds = null }: FindingsGraphViewProps) {
  const [graph, setGraph] = useState<FindingsGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [transform, setTransform] = useState<ZoomTransform>(zoomIdentity);
  // Set by either mouse hover or keyboard focus on a node - both drive the same "highlight this
  // node and its direct neighbors, dim everything else" treatment, so Tab-navigating the graph is
  // exactly as legible as hovering it.
  const [activeId, setActiveId] = useState<string | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const transformRef = useRef(transform);
  const zoomBehaviorRef = useRef(zoom<SVGSVGElement, unknown>().scaleExtent([0.2, 3]));

  useEffect(() => {
    transformRef.current = transform;
  }, [transform]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchFindingsGraph(missionId)
      .then((g) => {
        if (!cancelled) setGraph(g);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load graph");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [missionId]);

  useEffect(() => {
    if (!graph) return;
    const layout = computeLayout(graph.nodes, graph.edges, LAYOUT_WIDTH, LAYOUT_HEIGHT);
    setPositions(Object.fromEntries(layout));
  }, [graph]);

  // Deliberately depends on `graph`, not `[]` - the <svg> only exists once the loading/error/empty
  // early-returns below stop firing (i.e. once data has actually loaded), so a mount-only effect
  // would run before svgRef.current is ever set and never attach the zoom behavior at all.
  useEffect(() => {
    if (!svgRef.current) return;
    const zoomBehavior = zoomBehaviorRef.current.on("zoom", (event) => setTransform(event.transform));
    const selection = select(svgRef.current);
    selection.call(zoomBehavior);
    return () => {
      selection.on(".zoom", null);
    };
  }, [graph]);

  const nodeById = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph]);

  // Node ids directly connected to `activeId` by an edge, in either direction - recomputed only
  // when the graph or the active node changes, not on every hover-driven render.
  const neighborIds = useMemo(() => {
    if (!activeId || !graph) return null;
    const neighbors = new Set<string>();
    for (const edge of graph.edges) {
      if (edge.source === activeId) neighbors.add(edge.target);
      else if (edge.target === activeId) neighbors.add(edge.source);
    }
    return neighbors;
  }, [activeId, graph]);

  const isFindingNode = (node: FindingsGraphNode) => FINDING_TYPES.includes(node.type as FindingType);

  // Filter-bar dimming and hover/focus dimming are mutually exclusive - hovering a node is a
  // request to trace its connections regardless of what's currently filtered, so it takes over
  // completely rather than compounding into a barely-visible graph.
  const nodeOpacity = (node: FindingsGraphNode): number => {
    if (activeId) return node.id === activeId || neighborIds?.has(node.id) ? 1 : 0.15;
    if (visibleFindingIds && isFindingNode(node) && !visibleFindingIds.has(node.id)) return 0.2;
    return 1;
  };

  const edgeOpacity = (edge: FindingsGraphEdge): number => {
    if (activeId) return edge.source === activeId || edge.target === activeId ? 0.9 : 0.05;
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    const sourceDim = !!(visibleFindingIds && source && isFindingNode(source) && !visibleFindingIds.has(source.id));
    const targetDim = !!(visibleFindingIds && target && isFindingNode(target) && !visibleFindingIds.has(target.id));
    return sourceDim || targetDim ? 0.08 : 0.35;
  };

  const handleZoom = (factor: number) => {
    if (!svgRef.current) return;
    select(svgRef.current).call(zoomBehaviorRef.current.scaleBy, factor);
  };

  const handleResetView = () => {
    if (!svgRef.current) return;
    select(svgRef.current).call(zoomBehaviorRef.current.transform, zoomIdentity);
  };

  const attachDrag = (nodeId: string) => (el: SVGGElement | null) => {
    if (!el) return;
    let moved = false;
    const behavior = drag<SVGGElement, unknown>()
      .on("start", () => {
        moved = false;
      })
      .on("drag", (event) => {
        if (Math.abs(event.dx) > 0.5 || Math.abs(event.dy) > 0.5) moved = true;
        const k = transformRef.current.k;
        setPositions((prev) => {
          const cur = prev[nodeId];
          if (!cur) return prev;
          return { ...prev, [nodeId]: { x: cur.x + event.dx / k, y: cur.y + event.dy / k } };
        });
      })
      .on("end", () => {
        const node = nodeById.get(nodeId);
        if (!moved && node && FINDING_TYPES.includes(node.type as FindingType)) onSelectFindingId(nodeId);
      });
    select(el).call(behavior);
  };

  if (loading) {
    return (
      <GlassPanel padding="lg">
        <SkeletonRows count={6} />
      </GlassPanel>
    );
  }

  if (error) {
    return (
      <GlassPanel padding="lg">
        <p className="text-xs text-critical">{error}</p>
      </GlassPanel>
    );
  }

  if (!graph || graph.nodes.length === 0) {
    return (
      <GlassPanel padding="lg">
        <p className="text-xs text-muted">No findings yet to graph - run a scan or add a finding first.</p>
      </GlassPanel>
    );
  }

  return (
    <GlassPanel padding="none" className="relative h-[560px] overflow-hidden">
      <div className="absolute right-2 top-2 z-10 flex flex-col gap-1">
        <IconButton icon={Plus} label="Zoom in" size="sm" onClick={() => handleZoom(1.3)} />
        <IconButton icon={Minus} label="Zoom out" size="sm" onClick={() => handleZoom(1 / 1.3)} />
        <IconButton icon={ResetIcon} label="Reset view" size="sm" onClick={handleResetView} />
      </div>

      <div className="absolute bottom-2 left-2 z-10 flex flex-col gap-1 rounded-lg border border-border bg-surface/80 px-2.5 py-2 text-[11px] backdrop-blur">
        {LEGEND.map((l) => (
          <div key={l.label} className="flex items-center gap-1.5 text-muted">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: TONE_COLOR[l.tone] }} />
            {l.label}
          </div>
        ))}
      </div>

      <div className="absolute left-2 top-2 z-10 rounded-lg border border-border bg-surface/80 px-2.5 py-1.5 text-[11px] text-muted backdrop-blur">
        {graph.nodes.length} node{graph.nodes.length === 1 ? "" : "s"} · {graph.edges.length} edge
        {graph.edges.length === 1 ? "" : "s"}
        {visibleFindingIds && (
          <span className="ml-1.5 text-primary">
            · {visibleFindingIds.size} matching filter{visibleFindingIds.size === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <svg ref={svgRef} className="h-full w-full cursor-grab active:cursor-grabbing" viewBox={`0 0 ${LAYOUT_WIDTH} ${LAYOUT_HEIGHT}`}>
        <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
          {graph.edges.map((edge, i) => {
            const source = positions[edge.source];
            const target = positions[edge.target];
            if (!source || !target) return null;
            return (
              <line
                key={`${edge.source}-${edge.target}-${i}`}
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                stroke="var(--color-border-strong)"
                strokeOpacity={edgeOpacity(edge)}
                strokeWidth={1}
                className="transition-[stroke-opacity] duration-150"
              >
                <title>{edge.relation.replace(/_/g, " ")}</title>
              </line>
            );
          })}

          {graph.nodes.map((node) => {
            const pos = positions[node.id];
            if (!pos) return null;
            const tone = NODE_TONE[node.type];
            const isFinding = isFindingNode(node);
            return (
              <g
                key={node.id}
                ref={attachDrag(node.id)}
                transform={`translate(${pos.x},${pos.y})`}
                className={cn("outline-none transition-opacity duration-150", isFinding ? "cursor-pointer" : "cursor-grab")}
                style={{ opacity: nodeOpacity(node) }}
                onMouseEnter={() => setActiveId(node.id)}
                onMouseLeave={() => setActiveId((cur) => (cur === node.id ? null : cur))}
                {...(isFinding
                  ? {
                      tabIndex: 0,
                      role: "button",
                      "aria-label": node.label,
                      onFocus: () => setActiveId(node.id),
                      onBlur: () => setActiveId((cur) => (cur === node.id ? null : cur)),
                      onKeyDown: (e: KeyboardEvent<SVGGElement>) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSelectFindingId(node.id);
                        }
                      },
                    }
                  : {})}
              >
                <circle
                  r={nodeRadius(node.type)}
                  fill={TONE_COLOR[tone]}
                  fillOpacity={0.85}
                  stroke={activeId === node.id ? "var(--color-primary)" : "var(--color-bg)"}
                  strokeWidth={activeId === node.id ? 2.5 : 1.5}
                />
                <text
                  y={nodeRadius(node.type) + 12}
                  textAnchor="middle"
                  className="pointer-events-none select-none fill-current text-[10px]"
                  style={{ fill: "var(--color-text)" }}
                >
                  {node.label.length > 22 ? `${node.label.slice(0, 22)}…` : node.label}
                </text>
                <title>{node.label}</title>
              </g>
            );
          })}
        </g>
      </svg>
    </GlassPanel>
  );
}
