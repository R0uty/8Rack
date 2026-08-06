export type FindingType =
  | "port"
  | "service"
  | "technology"
  | "domain"
  | "subdomain"
  | "directory"
  | "endpoint"
  | "credential"
  | "cookie"
  | "api"
  | "header"
  | "interesting_file"
  | "potential_vulnerability"
  | "confirmed_vulnerability"
  | "information"
  | "cve";

/** Same vocabulary as the (unused) types/scanner.ts stub - kept aligned deliberately. */
export type FindingSeverity = "info" | "low" | "medium" | "high" | "critical";

export type FindingStatus = "discovered" | "updated" | "verified" | "dismissed";

export interface FindingHistoryEntry {
  status: FindingStatus;
  at: number;
}

export interface Finding {
  id: string;
  projectId: string;
  type: FindingType;
  severity: FindingSeverity;
  title: string;
  description: string;
  /** Who/what produced this finding. */
  source: "scanner" | "agent" | "manual";
  /** Tool id (e.g. "nmap"), agent id, or "manual". */
  tool: string;
  /** 0-1 */
  confidence: number;
  /** Host/domain/IP/URL this finding is about. */
  target: string;
  /** Canonical dedupe value, e.g. "80/tcp", "nginx", "admin.example.com" - set by each parser. */
  value: string;
  metadata: Record<string, unknown>;
  /** Raw excerpt/proof text - doubles as "Raw Output" in the details UI. */
  evidence: string;
  tags: string[];
  status: FindingStatus;
  /** Every status transition, oldest first - powers the (future) Timeline UI. */
  history: FindingHistoryEntry[];
  /** Dedup counter - how many times this finding has been independently (re-)observed. */
  sourceCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
  createdAt: number;
  updatedAt: number;
}

/** What a parser returns - findingsManager fills in id/projectId/status/history/timestamps/sourceCount on ingest.
 * Parsers must never produce type "confirmed_vulnerability" - only "potential_vulnerability"; promotion to
 * confirmed is a human/agent action via PATCH /api/findings/:id. */
export type ParsedFinding = Pick<
  Finding,
  "type" | "severity" | "title" | "description" | "tool" | "confidence" | "target" | "value"
> &
  Partial<Pick<Finding, "metadata" | "evidence" | "tags">>;

/** Manual finding creation via POST /api/projects/:id/findings - source is forced to "manual" by the service. */
export type FindingCreateInput = Pick<Finding, "type" | "severity" | "title" | "description" | "target" | "value"> &
  Partial<Pick<Finding, "tool" | "confidence" | "metadata" | "evidence" | "tags">>;

export type FindingPatchInput = Partial<
  Pick<Finding, "severity" | "status" | "tags" | "description" | "title" | "confidence">
>;

export interface FindingsGraphNode {
  id: string;
  type: FindingType | "target" | "tool";
  label: string;
}

export type FindingsGraphRelation = "runs_on" | "discovered_by" | "uses" | "contains" | "connected_to" | "related_to";

export interface FindingsGraphEdge {
  source: string;
  target: string;
  relation: FindingsGraphRelation;
}

export interface FindingsGraph {
  nodes: FindingsGraphNode[];
  edges: FindingsGraphEdge[];
}

export interface FindingFilters {
  type?: FindingType;
  severity?: FindingSeverity;
  tool?: string;
  target?: string;
  tag?: string;
}
