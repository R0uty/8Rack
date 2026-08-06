export type AppView = "chat" | "workbench" | "plans" | "findings";

export const VIEW_LABEL: Record<AppView, string> = {
  chat: "Chat",
  workbench: "Workbench",
  plans: "Plans",
  findings: "Findings",
};
