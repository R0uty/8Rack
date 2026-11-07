import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InvalidMissionIdError } from "./errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Every mission's data (metadata + scoped history) lives under its own subdirectory here. */
export const MISSIONS_DIR = path.resolve(__dirname, "../../data/missions");

/** Every mission id is minted by `createMission` via `randomUUID()` (missionManager.ts) - nothing
 * else ever creates a mission directory. Rejecting anything that doesn't look like one here, at
 * the single chokepoint every mission-scoped filesystem path funnels through (every service only
 * ever reaches disk via missionDir/readMissionJson/writeMissionJson below, or missionManager.ts's
 * own direct missionDir() calls), closes off path traversal via a crafted `missionId` - e.g.
 * `"../../../../tmp/x"` - reaching a route/service with only a "non-empty string" check, which
 * would otherwise let `path.join(MISSIONS_DIR, id)` resolve well outside MISSIONS_DIR entirely. */
const MISSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function missionDir(id: string): string {
  if (!MISSION_ID_PATTERN.test(id)) throw new InvalidMissionIdError(id);
  return path.join(MISSIONS_DIR, id);
}

/** Directory names under MISSIONS_DIR, i.e. every mission id that has ever been created. */
export async function listMissionIds(): Promise<string[]> {
  try {
    const entries = await readdir(MISSIONS_DIR, { withFileTypes: true });
    // Anything else in here (a stray directory, a backup copy) isn't a mission - left in, missionDir
    // would reject it and that one directory would fail every listMissions() and all of startup
    // hydration.
    return entries.filter((e) => e.isDirectory() && MISSION_ID_PATTERN.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function readMissionJson<T>(id: string, filename: string): Promise<T[]> {
  // missionDir(id) is resolved outside the try/catch below so an InvalidMissionIdError propagates
  // as a real error - a "file doesn't exist yet" ENOENT (the case that catch is actually for) must
  // never look identical to "this id was rejected outright".
  const dir = missionDir(id);
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
    // graceful [] fallback, so a silently-emptied mission's history at least leaves a trace.
    console.warn(`[missionStore] "${filename}" for mission "${id}" contains invalid JSON - treating as empty.`, err);
    return [];
  }
}

/** Writes via a temp file + rename so a crash mid-write leaves the previous complete file in place -
 * a truncated JSON file reads back as "no data" (readMissionJson above), and the next persist would
 * then permanently overwrite the mission's real history with that empty view. */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, content);
    await rename(tempPath, filePath);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Serializes writeMissionJson calls to the same mission+file so two overlapping writes can't race -
 * without this, an older call's write could land after a newer call's, permanently reverting the
 * file to a stale snapshot. Keyed per mission+filename, so unrelated files for the same mission don't
 * needlessly serialize against each other. A failed write doesn't wedge the queue.
 *
 * Coalesces: while one write is in flight, every newer call replaces the single queued payload and
 * shares its promise, since each call carries a whole-file snapshot and only the newest matters.
 * A tool run producing thousands of findings otherwise queues thousands of full-file rewrites.
 */
interface WriteQueue {
  inFlight: Promise<void>;
  next?: { content: () => string; dir: string; filePath: string; done: Promise<void> };
}
const writeQueues = new Map<string, WriteQueue>();

async function performWrite(dir: string, filePath: string, content: () => string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(filePath, content());
}

function enqueueWrite(key: string, dir: string, filePath: string, content: () => string): Promise<void> {
  const queue = writeQueues.get(key);
  if (!queue) {
    const inFlight = performWrite(dir, filePath, content);
    const entry: WriteQueue = { inFlight };
    writeQueues.set(key, entry);
    const settle = () => {
      if (!entry.next) writeQueues.delete(key);
    };
    void inFlight.then(settle, settle);
    return inFlight;
  }

  if (queue.next) {
    queue.next.content = content;
    return queue.next.done;
  }

  const next: NonNullable<WriteQueue["next"]> = { content, dir, filePath, done: Promise.resolve() };
  const run = () => {
    queue.next = undefined;
    const running = performWrite(next.dir, next.filePath, next.content);
    queue.inFlight = running;
    const settle = () => {
      if (!queue.next && queue.inFlight === running) writeQueues.delete(key);
    };
    void running.then(settle, settle);
    return running;
  };
  next.done = queue.inFlight.then(run, run);
  queue.next = next;
  return next.done;
}

export async function writeMissionJson<T>(id: string, filename: string, data: T[]): Promise<void> {
  const dir = missionDir(id); // validated/resolved before even entering the queue
  return enqueueWrite(`${id}:${filename}`, dir, path.join(dir, filename), () => JSON.stringify(data, null, 2));
}
