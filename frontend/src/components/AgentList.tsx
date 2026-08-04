import type { CSSProperties } from "react";
import type { AgentWithStatus } from "../types/agent";

interface AgentListProps {
  agents: AgentWithStatus[];
  loading: boolean;
  error: string | null;
  selectedAgentId: string | null;
  onSelectAgent: (agent: AgentWithStatus) => void;
  onRefresh: () => void;
}

export function AgentList({ agents, loading, error, selectedAgentId, onSelectAgent, onRefresh }: AgentListProps) {
  return (
    <section className="agent-list">
      <div className="agent-list__header">
        <h2 className="agent-list__heading">Agents</h2>
        <button
          type="button"
          className="agent-list__refresh"
          onClick={onRefresh}
          disabled={loading}
          title="Reload agent configs"
        >
          {loading ? "..." : "↻"}
        </button>
      </div>

      {error && <p className="agent-list__error">{error}</p>}
      {!error && !loading && agents.length === 0 && <p className="agent-list__placeholder">No agents found</p>}

      <ul className="agent-list__items">
        {agents.map((agent) => {
          const active = agent.id === selectedAgentId;
          const style = { "--agent-color": agent.color } as CSSProperties;
          return (
            <li key={agent.id}>
              <button
                type="button"
                className={`agent-list__item${active ? " agent-list__item--active" : ""}`}
                style={style}
                onClick={() => onSelectAgent(agent)}
                title={active ? "Click to deselect" : agent.description}
              >
                <span className="agent-list__item-icon" aria-hidden="true">
                  {agent.icon}
                </span>
                <span className="agent-list__item-main">
                  <span className="agent-list__item-top">
                    <span className="agent-list__item-name">{agent.name}</span>
                    <span
                      className={`agent-list__status agent-list__status--${agent.status}`}
                      title={agent.status === "online" ? "Model available" : "Model unavailable"}
                    >
                      <span className="agent-list__status-dot" />
                      {agent.status}
                    </span>
                  </span>
                  <span className="agent-list__item-description">{agent.description}</span>
                  <span className="agent-list__item-model">{agent.model}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
