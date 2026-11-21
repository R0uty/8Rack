import type { Tone } from "../components/ui";
import type { FindingStatus } from "../types/finding";

/** Shared across FindingsView/FindingsTable/FindingDetails. */
export { FINDING_STATUSES } from "../types/finding";

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
