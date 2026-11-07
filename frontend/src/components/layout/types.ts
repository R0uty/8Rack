/**
 * The nav: a mission's own work first, then what configures every mission. The mission itself is
 * picked once in the sidebar (see MissionSwitcher) rather than per view.
 */
export type AppView = "factory" | "workorders" | "assets" | "findings" | "reports" | "agents" | "tools";

export const VIEW_LABEL: Record<AppView, string> = {
  factory: "Factory",
  workorders: "Work Orders",
  assets: "Assets",
  findings: "Findings",
  reports: "Reports",
  agents: "Agents",
  tools: "Tools",
};

/** Nav order, in display order. */
export const PRIMARY_VIEWS: AppView[] = ["factory", "workorders", "assets", "findings", "reports", "agents", "tools"];
