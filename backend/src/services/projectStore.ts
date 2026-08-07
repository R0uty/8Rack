import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InvalidProjectIdError } from "./errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Every project's data (metadata + scoped history) lives under its own subdirectory here. */
export const PROJECTS_DIR = path.resolve(__dirname, "../../data/projects");

/** Every project id is minted by `createProject` via `randomUUID()` (projectManager.ts) - nothing
 * else ever creates a project directory. Rejecting anything that doesn't look like one here, at
 * the single chokepoint every project-scoped filesystem path funnels through (every service only
 * ever reaches disk via projectDir/readProjectJson/writeProjectJson below, or projectManager.ts's
 * own direct projectDir() calls), closes off path traversal via a crafted `projectId` - e.g.
 * `"../../../../tmp/x"` - reaching a route/service with only a "non-empty string" check, which
 * would otherwise let `path.join(PROJECTS_DIR, id)` resolve well outside PROJECTS_DIR entirely. */
const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function projectDir(id: string): string {
  if (!PROJECT_ID_PATTERN.test(id)) throw new InvalidProjectIdError(id);
  return path.join(PROJECTS_DIR, id);
}

/** Directory names under PROJECTS_DIR, i.e. every project id that has ever been created. */
export async function listProjectIds(): Promise<string[]> {
  try {
    const entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function readProjectJson<T>(id: string, filename: string): Promise<T[]> {
  // projectDir(id) is resolved outside the try/catch below so an InvalidProjectIdError propagates
  // as a real error - a "file doesn't exist yet" ENOENT (the case that catch is actually for) must
  // never look identical to "this id was rejected outright".
  const dir = projectDir(id);
  let raw: string;
  try {
    raw = await readFile(path.join(dir, filename), "utf-8");
  } catch {
    // Legitimately no data yet - the common case, silent by design.
    return [];
  }
  try {
    return JSON.parse(raw) as T[];
  } catch (err) {
    // Unlike a missing file, a file that exists but fails to parse means something went wrong
    // (e.g. a crash mid-writeFile) - worth a log even though the caller still gets the same
    // graceful [] fallback, so a silently-emptied project's history at least leaves a trace.
    console.warn(`[projectStore] "${filename}" for project "${id}" contains invalid JSON - treating as empty.`, err);
    return [];
  }
}

/** Serializes writeProjectJson calls to the same project+file so two overlapping writes can't
 * race - without this, an older call's writeFile could resolve after a newer call's, permanently
 * reverting the file to a stale snapshot with nothing to indicate it happened (invisible until the
 * next restart re-hydrates from that now-stale copy). Keyed per project+filename, not just per
 * project, so unrelated files for the same project - e.g. executions.json and tasks.json - don't
 * needlessly serialize against each other. A failed write still lets the next one in the queue run
 * (`.then(task, task)`, not just `.then(task)`) so one bad write can't permanently wedge a
 * project's queue. */
const writeQueues = new Map<string, Promise<void>>();

function enqueueWrite(key: string, task: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const result = previous.then(task, task);
  writeQueues.set(key, result);
  return result;
}

export async function writeProjectJson<T>(id: string, filename: string, data: T[]): Promise<void> {
  const dir = projectDir(id); // validated/resolved before even entering the queue
  return enqueueWrite(`${id}:${filename}`, async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, filename), JSON.stringify(data, null, 2));
  });
}
