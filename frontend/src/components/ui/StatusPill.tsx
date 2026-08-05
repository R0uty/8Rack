import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export type Tone = "primary" | "info" | "warning" | "critical" | "neutral";

const DOT_TONE: Record<Tone, string> = {
  primary: "bg-primary",
  info: "bg-info",
  warning: "bg-warning",
  critical: "bg-critical",
  neutral: "bg-muted",
};

const PILL_TONE: Record<Tone, string> = {
  primary: "bg-primary-dim text-primary",
  info: "bg-info-dim text-info",
  warning: "bg-warning-dim text-warning",
  critical: "bg-critical-dim text-critical",
  neutral: "bg-card text-muted border border-border",
};

interface StatusDotProps {
  tone: Tone;
  pulse?: boolean;
  className?: string;
}

/** Small colored dot, e.g. for an inline list item. `pulse` animates a soft glow — reserve for
 * genuinely live/online states, not every dot. */
export function StatusDot({ tone, pulse = false, className }: StatusDotProps) {
  return (
    <span
      className={cn(
        "inline-block h-2 w-2 rounded-full",
        DOT_TONE[tone],
        pulse && "animate-pulse-dot",
        className,
      )}
    />
  );
}

interface StatusPillProps {
  tone: Tone;
  children: ReactNode;
  dot?: boolean;
  pulse?: boolean;
  className?: string;
}

/** Pill/badge with a semantic tone - unifies the status-pill/dot/badge treatments that used to be
 * implemented ad hoc per component (StatusBar text, AgentList dot+text, ToolRegistry dot,
 * Workbench/Planner task-status pills, ExecutionConsole success/failure badge). */
export function StatusPill({ tone, children, dot = true, pulse = false, className }: StatusPillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-xs font-medium",
        PILL_TONE[tone],
        className,
      )}
    >
      {dot && <StatusDot tone={tone} pulse={pulse} />}
      {children}
    </span>
  );
}
