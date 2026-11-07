import { RefreshCw } from "lucide-react";
import { useMcpServers } from "../hooks/useMcpServers";
import { Button, GlassPanel, SectionHeading, Skeleton, StatusPill, type Tone } from "./ui";
import { relativeTime } from "../lib/relativeTime";
import type { McpServerState, McpServerStatus } from "../types/mcp";

const STATE: Record<McpServerState, { tone: Tone; label: string }> = {
  checking: { tone: "info", label: "checking" },
  online: { tone: "primary", label: "online" },
  error: { tone: "critical", label: "error" },
  misconfigured: { tone: "warning", label: "misconfigured" },
};

/**
 * The MCP servers named in the backend's .env and the tools each one offers (see
 * backend/src/services/mcpClient.ts). Read-only for now: agents can't call these tools until the
 * approval gate and enable switch are wired in - TODO.md "MCP tool and RAG providers", steps 2-3.
 */
export function McpServersPanel() {
  const { servers, loading, checking, error, check } = useMcpServers();

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
          <p className="text-xs text-muted">Tools these servers offer, for review. Agents can't use them yet.</p>
          {servers.map((server) => (
            <ServerCard key={server.id} server={server} />
          ))}
        </div>
      )}
    </section>
  );
}

function ServerCard({ server }: { server: McpServerStatus }) {
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
                <li key={tool.name} className="min-w-0 text-xs">
                  <span className="font-mono text-text">{tool.name}</span>
                  {tool.description && <span className="text-muted"> — {tool.description}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </GlassPanel>
  );
}
