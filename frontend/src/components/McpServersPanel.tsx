import { useState } from "react";
import { Power, RefreshCw } from "lucide-react";
import { useMcpServers } from "../hooks/useMcpServers";
import { Button, GlassPanel, IconButton, SectionHeading, Skeleton, StatusPill, type Tone } from "./ui";
import { relativeTime } from "../lib/relativeTime";
import type { McpServerState, McpServerStatus, McpToolInfo } from "../types/mcp";

const STATE: Record<McpServerState, { tone: Tone; label: string }> = {
  checking: { tone: "info", label: "checking" },
  online: { tone: "primary", label: "online" },
  error: { tone: "critical", label: "error" },
  misconfigured: { tone: "warning", label: "misconfigured" },
};

/**
 * The MCP servers named in the backend's .env and the tools each one offers (see
 * backend/src/services/mcpClient.ts). A discovered tool starts disabled; enabling it here lets agents
 * call it through the normal approval + scope flow - the same gate every local tool goes through.
 */
export function McpServersPanel() {
  const { servers, loading, checking, error, check, toggleTool } = useMcpServers();
  const [toggleError, setToggleError] = useState<string | null>(null);

  return (
    <section>
      <SectionHeading
        actions={
          servers && servers.length > 0 ? (
            <Button
              variant="secondary"
              size="sm"
              icon={RefreshCw}
              iconClassName={checking ? "animate-spin" : undefined}
              onClick={check}
              disabled={checking}
            >
              {checking ? "Checking…" : "Check again"}
            </Button>
          ) : undefined
        }
      >
        MCP Servers
      </SectionHeading>

      {error && <p className="mb-2 text-xs text-critical">{error}</p>}
      {toggleError && <p className="mb-2 text-xs text-critical">{toggleError}</p>}
      {loading && !servers && <Skeleton className="h-16 w-full" />}

      {servers && servers.length === 0 && (
        <GlassPanel padding="md">
          <p className="text-sm text-text">No MCP servers configured.</p>
          <p className="mt-1 text-xs text-muted">
            Add them to <span className="font-mono">backend/.env</span> as{" "}
            <span className="font-mono">MCP_SERVERS=tools=https://host/mcp</span>, put each server's token in{" "}
            <span className="font-mono">MCP_TOKEN_&lt;ID&gt;</span>, then restart the backend.
          </p>
        </GlassPanel>
      )}

      {servers && servers.length > 0 && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted">
            Enable a tool to let agents call it. Every call still needs human approval and stays within mission scope.
          </p>
          {servers.map((server) => (
            <ServerCard
              key={server.id}
              server={server}
              onToggle={async (id, enabled) => {
                setToggleError(null);
                try {
                  await toggleTool(id, enabled);
                } catch (err) {
                  setToggleError(err instanceof Error ? err.message : "Failed to toggle the tool");
                }
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ServerCard({ server, onToggle }: { server: McpServerStatus; onToggle: (id: string, enabled: boolean) => Promise<void> }) {
  const state = STATE[server.state];
  return (
    <GlassPanel padding="md">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-text">{server.id}</span>
        <StatusPill tone={state.tone} pulse={server.state === "checking"}>
          {state.label}
        </StatusPill>
        {server.checkedAt && <span className="text-xs text-muted">checked {relativeTime(server.checkedAt)}</span>}
      </div>
      {server.url && (
        <p className="mt-1 truncate font-mono text-[11px] text-muted" title={server.url}>
          {server.url}
        </p>
      )}
      {server.error && <p className="mt-2 text-xs text-critical">{server.error}</p>}

      {server.state === "online" && (
        <div className="mt-3">
          <p className="text-xs text-muted">
            {server.tools.length} tool{server.tools.length === 1 ? "" : "s"}
            {server.skippedTools > 0 &&
              ` · ${server.skippedTools} not listed (a name 8Rack doesn't accept, a duplicate, or past the limit)`}
          </p>
          {server.tools.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1.5">
              {server.tools.map((tool) => (
                <ToolRow key={tool.id} tool={tool} onToggle={onToggle} />
              ))}
            </ul>
          )}
        </div>
      )}
    </GlassPanel>
  );
}

function ToolRow({ tool, onToggle }: { tool: McpToolInfo; onToggle: (id: string, enabled: boolean) => Promise<void> }) {
  const [pending, setPending] = useState(false);
  return (
    <li className={`flex min-w-0 items-start gap-2 text-xs ${tool.enabled ? "" : "opacity-60"}`}>
      <IconButton
        icon={Power}
        label={tool.enabled ? `Disable ${tool.name}` : `Enable ${tool.name}`}
        size="sm"
        active={tool.enabled}
        disabled={pending}
        onClick={async () => {
          setPending(true);
          try {
            await onToggle(tool.id, !tool.enabled);
          } finally {
            setPending(false);
          }
        }}
      />
      <div className="min-w-0 flex-1">
        <span className="font-mono text-text">{tool.name}</span>
        {tool.enabled ? (
          <StatusPill tone="primary" dot={false} className="ml-1.5 px-1.5 py-0.5">
            enabled
          </StatusPill>
        ) : (
          <StatusPill tone="neutral" dot={false} className="ml-1.5 px-1.5 py-0.5">
            disabled
          </StatusPill>
        )}
        {tool.description && <span className="text-muted"> — {tool.description}</span>}
      </div>
    </li>
  );
}
