import type { ReactNode } from "react";

interface SectionHeadingProps {
  children: ReactNode;
  actions?: ReactNode;
}

/** Small uppercase section label + optional right-aligned actions (refresh button, etc.) - used
 * atop every sidebar/panel section (Model, Agents, Missions, Tool Registry, ...). */
export function SectionHeading({ children, actions }: SectionHeadingProps) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">{children}</h2>
      {actions}
    </div>
  );
}
