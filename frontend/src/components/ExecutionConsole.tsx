import type { ExecutionResult, ExecutionStatus } from "../types/execTool";
import type { LiveOutputChunk } from "../hooks/useOrchestratorTask";

interface ExecutionConsoleProps {
  toolId: string;
  resolvedCommand: string;
  status: ExecutionStatus;
  result?: ExecutionResult;
  /** Chunks received so far, in order — used while the execution is still streaming (no result yet). */
  liveOutput?: LiveOutputChunk[];
}

const STATUS_LABEL: Record<ExecutionStatus, string> = {
  pending_confirmation: "Awaiting confirmation",
  running: "Running…",
  completed: "Completed",
  rejected: "Rejected",
  cancelled: "Cancelled",
  failed: "Failed",
};

export function ExecutionConsole({ toolId, resolvedCommand, status, result, liveOutput }: ExecutionConsoleProps) {
  return (
    <div className="exec-console">
      <div className="exec-console__header">
        <span className="exec-console__tool">{toolId}</span>
        <span className={`exec-console__status exec-console__status--${status}`}>{STATUS_LABEL[status]}</span>
      </div>
      <pre className="exec-console__command">$ {resolvedCommand}</pre>

      {liveOutput && liveOutput.length > 0 && (
        <pre className="exec-console__output">
          {liveOutput.map((chunk, i) => (
            <span key={i} className={`exec-console__chunk exec-console__chunk--${chunk.stream}`}>
              {chunk.data}
            </span>
          ))}
        </pre>
      )}

      {!liveOutput?.length && result && (result.stdout || result.stderr) && (
        <pre className="exec-console__output">
          {result.stdout && <span className="exec-console__chunk exec-console__chunk--stdout">{result.stdout}</span>}
          {result.stderr && <span className="exec-console__chunk exec-console__chunk--stderr">{result.stderr}</span>}
        </pre>
      )}

      {result && (
        <div className="exec-console__footer">
          <span className={result.success ? "exec-console__badge exec-console__badge--success" : "exec-console__badge exec-console__badge--failure"}>
            {result.success ? "Success" : "Failure"}
          </span>
          <span>exit {result.exitCode ?? "—"}</span>
          <span>{result.executionTimeMs}ms</span>
          {result.timedOut && <span className="exec-console__flag">timed out</span>}
          {result.cancelled && <span className="exec-console__flag">cancelled</span>}
          {result.truncated && <span className="exec-console__flag">output truncated</span>}
        </div>
      )}
    </div>
  );
}
