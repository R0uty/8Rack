/**
 * The factory-centric nav: missions/assets/workorders/findings/reports/agents/tools, plus the
 * Factory Dashboard as the default landing view. Settings stays the existing always-available-
 * from-anywhere gear-icon Sheet modal (TopBar -> SettingsPanel) rather than a tab, since folding it
 * into the tab system would regress that "reachable from any view" property.
 *
 * Chat/Workbench/Plans and a standalone Evidence view were cut from here on the user's explicit
 * "too complicated, simplify" instruction: Work Orders now covers what Workbench's freestanding
 * "give an agent an objective + tools" UI did (just mission-scoped and human-approved, same as
 * everything else), the Factory Director's automatic work-order dependency chains cover what
 * user-authored multi-agent Plans did, plain (no-mission) manual chat never fit the mission model
 * to begin with, and Evidence was purely a reshape of Finding.evidence with no independent
 * existence - folded back into Findings as a tab. See DEVELOPMENT.md's "Nav simplification" note.
 */
export type AppView = "factory" | "missions" | "assets" | "workorders" | "findings" | "reports" | "agents" | "tools";

export const VIEW_LABEL: Record<AppView, string> = {
  factory: "Factory",
  missions: "Missions",
  assets: "Assets",
  workorders: "Work Orders",
  findings: "Findings",
  reports: "Reports",
  agents: "Agents",
  tools: "Tools",
};

/** Nav order, in display order. */
export const PRIMARY_VIEWS: AppView[] = [
  "factory",
  "missions",
  "assets",
  "workorders",
  "findings",
  "reports",
  "agents",
  "tools",
];
