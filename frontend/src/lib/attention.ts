import { agentName } from "./agentName";
import type { AgentWithStatus } from "../types/agent";
import type { FactoryPreview, MissionAttention } from "../types/attention";

/** How many items in the queue want a decision (running tools don't). */
export function needsYouCount(attention: MissionAttention): number {
  return attention.approvals.length + attention.guidance.length + attention.failed.length;
}

/** One line under the pipeline saying what Advance would do - the button alone gave no preview. */
export function describePreview(preview: FactoryPreview | null, agents: AgentWithStatus[]): string | null {
  if (!preview) return null;
  if (preview.next) {
    const on = preview.next.target ? ` on ${preview.next.target}` : "";
    return `Next: ${agentName(agents, preview.next.agentId)}${on}${preview.next.existing ? "" : " (new work order)"}.`;
  }
  if (preview.blockedReason) return preview.blockedReason;
  const waiting = preview.waitingOnApproval + preview.waitingOnGuidance;
  if (waiting > 0) return `Nothing new to run - ${waiting} work order${waiting === 1 ? " is" : "s are"} waiting on you.`;
  if (preview.unsettledFindings > 0) return `Nothing to run - ${preview.unsettledFindings} finding${preview.unsettledFindings === 1 ? " needs" : "s need"} review.`;
  if (preview.confirmedFindings > 0) return `Nothing to run - ${preview.confirmedFindings} confirmed finding${preview.confirmedFindings === 1 ? "" : "s"} ready for a report.`;
  return "Nothing to run right now.";
}

