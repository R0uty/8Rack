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

export type FindingSeverity = "info" | "low" | "medium" | "high" | "critical";

export type FindingStatus = "potential" | "investigating" | "confirmed" | "false_positive" | "reported" | "duplicate";

export interface FindingHistoryEntry {
  status: FindingStatus;
  at: number;
}

export type EvidenceType =
  | "http_request"
  | "http_response"
  | "terminal_output"
  | "tool_result"
  | "agent_reasoning"
  | "note";

export interface EvidenceItem {
  type: EvidenceType;
  content: string;
  createdAt: number;
}

export interface Finding {
  id: string;
  projectId: string;
  type: FindingType;
  severity: FindingSeverity;
  title: string;
  description: string;
  source: "scanner" | "agent" | "manual";
  tool: string;
  confidence: number;
  target: string;
  value: string;
  parameter?: string;
  impact?: string;
  reproductionSteps?: string;
  metadata: Record<string, unknown>;
  evidence: EvidenceItem[];
  tags: string[];
  status: FindingStatus;
  history: FindingHistoryEntry[];
  sourceCount: number;
  executionIds: string[];
  relatedAgents: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  createdAt: number;
  updatedAt: number;
}

export type FindingCreateInput = Pick<Finding, "type" | "severity" | "title" | "description" | "target" | "value"> &
  Partial<Pick<Finding, "tool" | "confidence" | "metadata" | "tags" | "parameter" | "impact" | "reproductionSteps">> & {
    evidence?: string;
  };

export type FindingPatchInput = Partial<
  Pick<
    Finding,
    "severity" | "status" | "tags" | "description" | "title" | "confidence" | "parameter" | "impact" | "reproductionSteps"
  >
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
