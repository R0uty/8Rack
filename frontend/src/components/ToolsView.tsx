import { useState } from "react";
import { ToolRegistry } from "./ToolRegistry";
import { ExecutionHistoryPanel } from "./ExecutionHistoryPanel";
import { ScannerPanel } from "./ScannerPanel";
import { KnowledgeBasePanel } from "./KnowledgeBasePanel";
import { McpServersPanel } from "./McpServersPanel";
import { NoMission } from "./NoMission";
import { Button } from "./ui";
import { cn } from "../lib/cn";
import { useTools } from "../hooks/useTools";
import { useRefreshOnActivate } from "../hooks/useRefreshOnActivate";
import type { AgentWithStatus } from "../types/agent";
import type { Mission } from "../types/mission";

type Tab = "scans" | "history" | "registry" | "knowledge" | "mcp";
const TABS: { tab: Tab; label: string }[] = [
  { tab: "scans", label: "Scans" },
  { tab: "history", label: "History" },
  { tab: "registry", label: "Registry" },
  { tab: "knowledge", label: "Knowledge base" },
  { tab: "mcp", label: "MCP servers" },
];

interface ToolsViewProps {
  agents: AgentWithStatus[];
  mission: Mission | null;
  active?: boolean;
}

/** Running tools (Scans), what ran (History), and what's available to run (Registry, Knowledge base, MCP
 * servers).
 * Tabs stay mounted when hidden, so a scan keeps streaming while you look at something else. */
export function ToolsView({ agents, mission, active = true }: ToolsViewProps) {
  const [tab, setTab] = useState<Tab>("scans");
  const { tools, executions, loading, error, refresh, toggleTool } = useTools(mission?.id ?? null);
  useRefreshOnActivate(active, refresh);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-1.5">
        {TABS.map(({ tab: t, label }) => (
          <Button key={t} variant={tab === t ? "primary" : "secondary"} size="sm" onClick={() => setTab(t)}>
            {label}
          </Button>
        ))}
      </div>

      <div className={cn(tab !== "scans" && "hidden")}>{mission ? <ScannerPanel missionId={mission.id} /> : <NoMission />}</div>
      <div className={cn(tab !== "history" && "hidden")}>
        {mission ? <ExecutionHistoryPanel executions={executions} loading={loading} error={error} agents={agents} /> : <NoMission />}
      </div>
      <div className={cn(tab !== "registry" && "hidden")}>
        <ToolRegistry tools={tools} loading={loading} error={error} onToggleEnabled={toggleTool} />
      </div>
      <div className={cn(tab !== "knowledge" && "hidden")}>
        <KnowledgeBasePanel />
      </div>
      <div className={cn(tab !== "mcp" && "hidden")}>
        <McpServersPanel />
      </div>
    </div>
  );
}
