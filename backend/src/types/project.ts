export type MissionStatus = "planning" | "active" | "paused" | "completed";

/**
 * Mission fields layered onto Project (see CLAUDE.md's "Projects" section for why Project stays
 * the technical/UI term rather than being renamed to "Mission" - these fields are additive, all
 * optional so existing project.json files with none of them keep working unmodified).
 */
export interface Project {
  id: string;
  name: string;
  notes: string;
  createdAt: number;
  description?: string;
  /** Target patterns this mission is authorized against - domains, "*.sub.example.com" wildcards,
   * bare IPs, CIDR ranges, or full URLs (only the hostname is compared). Enforced best-effort
   * against tool arguments and exactly against Scan Profile targets - see services/scopeMatcher.ts. */
  scope?: string[];
  /** Same pattern vocabulary as `scope` - explicitly excluded even if it would otherwise match a
   * broad `scope` entry (e.g. a carved-out subdomain). Checked before `scope`. */
  outOfScope?: string[];
  rules?: string;
  startDate?: number;
  status?: MissionStatus;
}
