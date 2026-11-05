import { Check } from "lucide-react";
import type { Mission, MissionStatus } from "../types/mission";
import { cn } from "../lib/cn";

/** One stage per real mission status - what the Director actually tracks. */
const STAGES: { label: string; statuses: MissionStatus[] }[] = [
  { label: "Scope", statuses: ["draft", "ready"] },
  { label: "Recon", statuses: ["recon"] },
  { label: "Investigate", statuses: ["investigating"] },
  { label: "Validate", statuses: ["validating"] },
  { label: "Report", statuses: ["reporting"] },
  { label: "Review", statuses: ["review", "completed"] },
];

export function FactoryPipeline({ mission }: { mission: Mission }) {
  const status = mission.status ?? "draft";
  const current = STAGES.findIndex((stage) => stage.statuses.includes(status));

  return (
    <div>
      <ol className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
        {STAGES.map((stage, i) => {
          const done = current !== -1 && (i < current || status === "completed");
          const isCurrent = i === current && status !== "completed";
          return (
            <li
              key={stage.label}
              aria-current={isCurrent ? "step" : undefined}
              className={cn(
                "flex items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-[11px] font-medium",
                isCurrent ? "border-primary/50 bg-primary-dim text-primary" : done ? "border-border text-text" : "border-border/50 text-muted",
              )}
            >
              {done && <Check size={11} className="text-primary" />}
              {stage.label}
            </li>
          );
        })}
      </ol>
      {current === -1 && <p className="mt-2 text-xs text-warning">This mission is {status}.</p>}
    </div>
  );
}
