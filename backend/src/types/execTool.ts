/**
 * The OS-command execution tool system ("Tool Execution Framework"). Distinct from
 * types/tool.ts's `Tool` (in-process Ollama-native function-calling) — an ExecTool spawns a real
 * OS process via toolExecutor.ts. Named separately to avoid confusion between the two.
 */

export type ExecToolCategory = "recon" | "network" | "web" | "fuzzing" | "analysis" | "os" | "reporting";

/** How raw stdout gets post-processed into ExecutionResult.parsedOutput. */
export type OutputParserKind = "text" | "lines" | "json";

export interface ExecTool {
  id: string;
  name: string;
  description: string;
  /** Guidance for an agent autonomously deciding *whether and how* to call this tool from a bare
   * objective, with no tool named by the user - "when to reach for this" plus a minimal example of
   * the caller-supplied `arguments` shape (i.e. the part after `defaultArguments`, which the model
   * never sees or supplies itself). Kept separate from `description` (shown to the human in the
   * Tool Registry UI, which stays short) rather than folded into it - see
   * orchestrator.ts#buildToolsPreamble, the only place this is read. */
  usageHint?: string;
  category: ExecToolCategory;
  /** Binary name (resolved via PATH) or absolute path. */
  executable: string;
  /** Arguments always prepended before the caller-supplied ones. */
  defaultArguments: string[];
  /** Regex source strings; if set, every caller-supplied argument must match at least one. */
  allowedArguments?: string[];
  /** Hard execution timeout in milliseconds. */
  timeout: number;
  /** Author-level toggle — disabled tools are rejected outright, distinct from availability. */
  enabled: boolean;
  /** Whether a human must confirm before this tool actually runs. */
  requiresConfirmation: boolean;
  parser: OutputParserKind;
  /** Emoji shown in the Tool Registry UI. */
  icon: string;
  /** Flag that prints the executable's version and exits without side effects (e.g. "--version",
   * "-V"). Omitted for tools where no such flag is known to be safe (e.g. it might otherwise be
   * misread as a query argument) - version is then left undetected rather than guessed. */
  versionFlag?: string;
  /** For tools whose command name collides with an unrelated program on some systems - e.g.
   * MissionDiscovery `httpx` (the recon prober this tool is built for) vs `python-httpx`'s CLI, both
   * of which install as `httpx`. A regex (source string, matched case-insensitively) that the
   * resolved binary's `versionFlag` output must contain for it to count as the genuine tool. A
   * binary that resolves but doesn't match is reported `unavailable` (and refused at execution)
   * rather than run and left to fail on flags it doesn't have. Requires `versionFlag` to be set. */
  identitySignature?: string;
}

export type ExecToolAvailability = "available" | "unavailable";

/** An ExecTool annotated with whether its executable actually resolves on this machine. */
export interface ExecToolWithStatus extends ExecTool {
  availability: ExecToolAvailability;
  resolvedPath?: string;
  /** First line of `<executable> --version`'s output, best-effort - undefined if the tool is
   * unavailable, doesn't support the flag, or didn't respond within the short probe timeout. */
  version?: string;
}

/** The standardized Tool Request format. */
export interface ToolRequestBody {
  tool: string;
  arguments: string[];
  missionId: string;
  /** Piped to the process's stdin — used by tools like write_file. */
  stdin?: string;
  /** Set by the Orchestrator (from OrchestratorTask.agentId) when a request is agent-driven -
   * absent for a direct/manual tool request made straight from the Workbench with no agent
   * involved. Carried through onto the resulting ExecutionRecord. */
  agentId?: string;
}

/** Marks an execution that runs on an MCP tool server (services/mcpClient.ts) instead of a local
 * process. The approval gate, scope check, history and findings ingestion are identical; only the
 * actual run differs - it's a call to the server, not a spawn. See toolManager.ts#runMcpRecord. */
export interface McpExecution {
  serverId: string;
  /** The tool's name on the server (e.g. "nmap") - distinct from the catalog id ("tools.nmap"). Also
   * the key findings ingestion parses the output under, so an MCP nmap feeds the nmap parser. */
  toolName: string;
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  executionTimeMs: number;
  success: boolean;
  timedOut: boolean;
  cancelled: boolean;
  /** True if stdout or stderr was truncated at the output size limit. */
  truncated: boolean;
  parsedOutput?: unknown;
}

export type ExecutionStatus =
  | "pending_confirmation"
  | "running"
  | "completed"
  | "rejected"
  | "cancelled"
  | "failed";

export interface ExecutionRecord {
  id: string;
  missionId: string;
  toolId: string;
  /** The agent that requested this execution, if any - see ToolRequestBody.agentId. */
  agentId?: string;
  arguments: string[];
  /** Human-readable resolved command, e.g. "nmap -sV -A 127.0.0.1". */
  resolvedCommand: string;
  cwd: string;
  status: ExecutionStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Set when the mission has scope configured but no target-shaped token could be found in this
   * execution's arguments - scope was NOT checked (as opposed to checked-and-clear), shown to the
   * human before they confirm. A clear violation blocks the request outright instead (see
   * services/scopeMatcher.ts#checkScope's "out_of_scope" verdict), so this only ever appears
   * alongside "pending_confirmation" or later. */
  scopeWarning?: string;
  /** Present when this execution runs on an MCP tool server rather than a local process. */
  mcp?: McpExecution;
  result?: ExecutionResult;
  error?: string;
}
