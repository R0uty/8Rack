import type { ExecToolWithStatus, ExecutionRecord } from "../types/execTool";

interface ToolRegistryProps {
  tools: ExecToolWithStatus[];
  executions: ExecutionRecord[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

/** executions is already newest-first from the backend, so the first match is the most recent. */
function lastExecutionFor(toolId: string, executions: ExecutionRecord[]): ExecutionRecord | undefined {
  return executions.find((e) => e.toolId === toolId);
}

export function ToolRegistry({ tools, executions, loading, error, onRefresh }: ToolRegistryProps) {
  return (
    <section className="tool-registry">
      <div className="tool-registry__header">
        <h2 className="tool-registry__heading">Tool Registry</h2>
        <button
          type="button"
          className="tool-registry__refresh"
          onClick={onRefresh}
          disabled={loading}
          title="Refresh tool list"
        >
          {loading ? "..." : "↻"}
        </button>
      </div>

      {error && <p className="tool-registry__error">{error}</p>}

      <div className="tool-registry__table-wrap">
        <table className="tool-registry__table">
          <thead>
            <tr>
              <th></th>
              <th>Name</th>
              <th>Category</th>
              <th>Executable</th>
              <th>Status</th>
              <th>Enabled</th>
              <th>Last run</th>
            </tr>
          </thead>
          <tbody>
            {tools.map((tool) => {
              const last = lastExecutionFor(tool.id, executions);
              return (
                <tr key={tool.id}>
                  <td className="tool-registry__icon" aria-hidden="true">
                    {tool.icon}
                  </td>
                  <td>
                    <div className="tool-registry__name">{tool.name}</div>
                    <div className="tool-registry__description">{tool.description}</div>
                  </td>
                  <td className="tool-registry__category">{tool.category}</td>
                  <td className="tool-registry__executable" title={tool.resolvedPath ?? tool.executable}>
                    {tool.executable}
                  </td>
                  <td>
                    <span className={`tool-registry__status tool-registry__status--${tool.availability}`}>
                      <span className="tool-registry__status-dot" />
                      {tool.availability}
                    </span>
                  </td>
                  <td>{tool.enabled ? "Yes" : "No"}</td>
                  <td>
                    {last ? (
                      <span className={`tool-registry__last tool-registry__last--${last.status}`}>{last.status}</span>
                    ) : (
                      <span className="tool-registry__last-none">never</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
