import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Button } from "./Button";

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  children?: ReactNode;
  /** The next thing to do. Left out when the handler isn't available (e.g. in a test without the
   * app's navigation). */
  action?: { label: string; onClick?: () => void; icon?: LucideIcon };
}

/** An empty list that says what to do next, not just that there's nothing here. */
export function EmptyState({ icon: Icon, title, children, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-panel border border-dashed border-border px-4 py-8 text-center">
      {Icon && <Icon size={20} className="text-muted" aria-hidden />}
      <p className="text-sm font-medium text-text">{title}</p>
      {children && <p className="max-w-md text-xs text-muted">{children}</p>}
      {action?.onClick && (
        <Button variant="primary" size="sm" icon={action.icon} onClick={action.onClick} className="mt-1">
          {action.label}
        </Button>
      )}
    </div>
  );
}
