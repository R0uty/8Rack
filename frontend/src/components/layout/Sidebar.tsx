import type { ReactNode } from "react";
import { Bot, FactoryIcon, FileText, ListChecks, Radar, ShieldAlert, Wrench } from "lucide-react";
import { FOCUS_RING, StatusPill } from "../ui";
import { cn } from "../../lib/cn";
import { type AppView, PRIMARY_VIEWS, VIEW_LABEL } from "./types";

interface SidebarProps {
  activeView: AppView;
  onChangeView: (view: AppView) => void;
  missionSwitcher: ReactNode;
  ollamaStatus: "unknown" | "connected" | "unavailable";
}

const NAV_ICON: Record<AppView, typeof Bot> = {
  factory: FactoryIcon,
  workorders: ListChecks,
  assets: Radar,
  findings: ShieldAlert,
  reports: FileText,
  agents: Bot,
  tools: Wrench,
};

export function Sidebar({ activeView, onChangeView, missionSwitcher, ollamaStatus }: SidebarProps) {
  return (
    <aside className="flex w-full shrink-0 flex-col border-b border-border bg-surface/80 backdrop-blur-xl md:h-full md:w-[232px] md:border-b-0 md:border-r">
      <div className="flex items-center gap-2.5 px-4 pb-2 pt-3 md:pb-3 md:pt-4">
        <img
          src="/8rack-icon.png"
          alt=""
          className="h-7 w-7 shrink-0 rounded-lg object-cover shadow-[0_0_16px_rgba(0,230,118,0.45)]"
        />
        <span className="text-sm font-semibold text-text">8Rack</span>
      </div>

      <div className="px-3 pb-2 md:pb-3">{missionSwitcher}</div>

      <nav className="flex gap-1 overflow-x-auto px-3 pb-2 md:flex-col md:overflow-visible md:pb-3">
        {PRIMARY_VIEWS.map((view) => {
          const Icon = NAV_ICON[view];
          const active = view === activeView;
          return (
            <button
              key={view}
              type="button"
              onClick={() => onChangeView(view)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-150",
                view === "agents" && "md:mt-3",
                FOCUS_RING,
                active ? "bg-primary-dim text-primary" : "text-muted hover:bg-card hover:text-text",
              )}
            >
              <Icon size={16} strokeWidth={2} />
              {VIEW_LABEL[view]}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto hidden border-t border-border px-4 py-3 md:block">
        <StatusPill
          tone={ollamaStatus === "connected" ? "primary" : ollamaStatus === "unavailable" ? "critical" : "neutral"}
          pulse={ollamaStatus === "connected"}
        >
          Ollama {ollamaStatus}
        </StatusPill>
      </div>
    </aside>
  );
}
