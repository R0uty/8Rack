/**
 * The 10-stage factory pipeline a mission moves through. `readMissionStatus` (missionManager.ts)
 * migrates the 4 legacy values a mission.json may still hold on disk (from before this expansion)
 * to their nearest equivalent here on every read, so old mission files keep working unmodified.
 */
export type MissionStatus =
  | "draft"
  | "ready"
  | "recon"
  | "investigating"
  | "validating"
  | "reporting"
  | "review"
  | "completed"
  | "paused"
  | "cancelled";

/** A mission.json written before the status expansion may still hold one of these. */
type LegacyMissionStatus = "planning" | "active" | "paused" | "completed";

const LEGACY_STATUS_MAP: Record<LegacyMissionStatus, MissionStatus> = {
  planning: "draft",
  active: "recon",
  paused: "paused",
  completed: "completed",
};

/** Maps a possibly-legacy status value read from disk to the current 10-value enum. Anything
 * already a current value (or undefined) passes through unchanged. */
export function migrateMissionStatus(status: string | undefined): MissionStatus | undefined {
  if (status === undefined) return undefined;
  if (status in LEGACY_STATUS_MAP) return LEGACY_STATUS_MAP[status as LegacyMissionStatus];
  return status as MissionStatus;
}

/**
 * Mission fields (see CLAUDE.md's "Missions" section for the domain vocabulary this app uses).
 */
export interface Mission {
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
