import type { Tone } from "../components/ui";
import type { FindingStatus } from "../types/finding";

/** Shared across FindingsTimeline/FindingsTable/FindingDetails - previously defined in
 * FindingsTimeline.tsx and imported by the other two, which made FindingsTimeline import back
 * from FindingsView (for SELECT_CLASS, see components/ui/selectClass.ts), creating two real
 * import cycles (View <-> Timeline <-> Table, View <-> Timeline <-> Details). Centralizing here -
 * a leaf module with no dependency on any Findings view - breaks both. FINDING_STATUSES was also
 * previously duplicated verbatim in FindingsTimeline.tsx and FindingDetails.tsx. */
export const FINDING_STATUSES: FindingStatus[] = [
  "potential",
  "investigating",
  "confirmed",
  "false_positive",
  "reported",
  "duplicate",
];

export const STATUS_TONE: Record<FindingStatus, Tone> = {
  potential: "info",
  investigating: "warning",
  confirmed: "primary",
  false_positive: "neutral",
  reported: "primary",
  duplicate: "neutral",
};

export const STATUS_VERB: Record<FindingStatus, string> = {
  potential: "Potential",
  investigating: "Investigating",
  confirmed: "Confirmed",
  false_positive: "False Positive",
  reported: "Reported",
  duplicate: "Duplicate",
};
