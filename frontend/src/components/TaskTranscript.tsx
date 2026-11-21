import { CheckCircle2, MessageSquare, Wrench, XCircle } from "lucide-react";
import { Markdown } from "./Markdown";
import { splitAgentOutput } from "../lib/agentOutput";
import type { OrchestratorTask } from "../types/orchestrator";

interface ToolResult {
  tool?: string;
  status?: string;
  success?: boolean;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
  message?: string;
  /** The backend answered with an identical earlier run's recorded output instead of running it again. */
  reused?: boolean;
  ranAt?: string;
}

/** How much of a tool's stdout to show inline - the full record is in Tools → History. */
const OUTPUT_PREVIEW = 600;

function parseToolResult(content: string): ToolResult {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as ToolResult) : { stdout: content };
  } catch {
    return { stdout: content };
  }
}

function ToolResultLine({ content }: { content: string }) {
  const r = parseToolResult(content);
  const failed = r.success === false || !!r.error || r.status === "failed" || r.status === "rejected" || r.status === "cancelled";
  const problem = r.error ?? r.message ?? (failed ? r.stderr : undefined);
  const output = (r.stdout ?? "").trim();
  const Icon = failed ? XCircle : CheckCircle2;
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-surface-2 px-2.5 py-1.5">
      <p className={`flex items-center gap-1.5 text-[11px] ${failed ? "text-critical" : "text-primary"}`}>
        <Icon size={11} aria-hidden />
        {r.tool ?? "Tool"} {r.status ?? (failed ? "failed" : "result")}
        {typeof r.exitCode === "number" && <span className="text-muted">(exit {r.exitCode})</span>}
        {r.reused && (
          <span className="text-muted" title={r.ranAt ? `Ran ${new Date(r.ranAt).toLocaleString()}` : undefined}>
            · earlier run reused, not run again
          </span>
        )}
      </p>
      {problem && <pre className="whitespace-pre-wrap font-mono text-[11px] text-critical">{problem}</pre>}
      {output && (
        <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] text-muted">
          {output.length > OUTPUT_PREVIEW ? `${output.slice(0, OUTPUT_PREVIEW)}…` : output}
        </pre>
      )}
    </div>
  );
}

/**
 * A work order's whole conversation: what the agent said, each tool it called and what came back,
 * and any note a human sent. Inspect used to show only the final answer.
 */
export function TaskTranscript({ task }: { task: OrchestratorTask }) {
  return (
    <ol className="flex flex-col gap-2" aria-label="Transcript">
      {task.messages.map((m, i) => {
        if (m.role === "user") {
          // The first user message is the order's objective, already on the card.
          if (i === 0) return null;
          return (
            <li key={i} className="flex gap-1.5 text-xs text-info">
              <MessageSquare size={12} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                <span className="font-medium">Note: </span>
                {m.content}
              </span>
            </li>
          );
        }
        if (m.role === "tool") {
          return (
            <li key={i}>
              <ToolResultLine content={m.content} />
            </li>
          );
        }
        return (
          <li key={i} className="flex flex-col gap-1 text-xs text-text">
            {splitAgentOutput(m.content).map((part, j) =>
              part.kind === "text" ? (
                <Markdown key={j} content={part.text} />
              ) : (
                <p key={j} className="flex items-center gap-1.5 font-mono text-[11px] text-info">
                  <Wrench size={11} aria-hidden />
                  {part.tool} {part.args.join(" ")}
                </p>
              ),
            )}
          </li>
        );
      })}
    </ol>
  );
}
