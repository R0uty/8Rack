import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";

type NoticeTone = "critical" | "warning" | "info" | "success";

const TONE: Record<NoticeTone, { className: string; icon: LucideIcon }> = {
  critical: { className: "border-critical/30 bg-critical-dim text-critical", icon: XCircle },
  warning: { className: "border-warning/30 bg-warning-dim text-warning", icon: AlertTriangle },
  info: { className: "border-info/30 bg-info-dim text-info", icon: Info },
  success: { className: "border-primary/30 bg-primary-dim text-primary", icon: CheckCircle2 },
};

interface NoticeProps {
  tone?: NoticeTone;
  children: ReactNode;
  /** A button or link placed at the end of the line, e.g. "Retry" or "Open editor". */
  action?: ReactNode;
  className?: string;
}

/**
 * The one way to show an error or a status line. Errors are announced to screen readers at once
 * (role="alert"); everything else politely (role="status"). Before this, errors were small red text
 * that nothing announced.
 */
export function Notice({ tone = "critical", children, action, className }: NoticeProps) {
  const { className: toneClass, icon: Icon } = TONE[tone];
  return (
    <div
      role={tone === "critical" ? "alert" : "status"}
      className={cn("flex items-start gap-2 rounded-lg border px-2.5 py-2 text-xs", toneClass, className)}
    >
      <Icon size={14} className="mt-px shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
