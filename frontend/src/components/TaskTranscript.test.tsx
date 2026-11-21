import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TaskTranscript } from "./TaskTranscript";
import type { OrchestratorTask } from "../types/orchestrator";

function task(messages: OrchestratorTask["messages"]): OrchestratorTask {
  return {
    id: "t1",
    missionId: "m1",
    agentId: "vulnerability-validator",
    objective: "Validate",
    messages,
    status: "completed",
    toolExecutionIds: [],
    toolCallCount: 1,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("TaskTranscript", () => {
  it("says when a result is an earlier run's recorded output, not a fresh run", () => {
    render(
      <TaskTranscript
        task={task([
          { role: "user", content: "Validate" },
          { role: "assistant", content: '{"tool": "nmap", "arguments": ["-sV", "127.0.0.1"]}' },
          {
            role: "tool",
            content: JSON.stringify({
              tool: "nmap",
              status: "completed",
              success: true,
              exitCode: 0,
              reused: true,
              ranAt: "2026-11-21T10:00:00.000Z",
              stdout: "3001/tcp open http",
            }),
          },
        ])}
      />,
    );
    expect(screen.getByText(/earlier run reused, not run again/)).toBeInTheDocument();
    expect(screen.getByText("3001/tcp open http")).toBeInTheDocument();
  });

  it("doesn't label a normal run as reused", () => {
    render(
      <TaskTranscript
        task={task([
          { role: "user", content: "Validate" },
          { role: "tool", content: JSON.stringify({ tool: "nmap", status: "completed", success: true, exitCode: 0, stdout: "ok" }) },
        ])}
      />,
    );
    expect(screen.queryByText(/earlier run reused/)).not.toBeInTheDocument();
  });
});
