import { useCallback, useEffect, useState } from "react";
import { fetchMcpServers, refreshMcpServers } from "../services/mcpApi";
import type { McpServerStatus } from "../types/mcp";

export function useMcpServers() {
  const [servers, setServers] = useState<McpServerStatus[] | null>(null);
  const [loading, setLoading] = useState(true);
  /** Separate from `loading` - a check connects to every server and can take up to the backend's
   * timeout, so the panel says so instead of showing its plain loading state. */
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      setServers(await refreshMcpServers());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to check the MCP servers");
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await fetchMcpServers();
        if (cancelled) return;
        setServers(loaded);
        // The backend's first check runs in the background at startup. Asking for one joins it
        // rather than starting another, so this just waits for its answer.
        if (loaded.some((s) => s.state === "checking")) void check();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load the MCP servers");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [check]);

  return { servers, loading, checking, error, check };
}
