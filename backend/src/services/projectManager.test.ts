import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeFs } from "../test-utils/fakeFs.js";

// See agentManager.test.ts for why the factory uses a dynamic import instead of a captured outer
// variable (vi.mock is hoisted above regular top-level statements, including plain imports).
vi.mock("node:fs/promises", async () => {
  const { createFakeFs } = await import("../test-utils/fakeFs.js");
  return createFakeFs();
});

import { createProject, deleteProject, getProject, listProjects, updateProject } from "./projectManager.js";
import { listProjectIds, readProjectJson, writeProjectJson } from "./projectStore.js";
import { InvalidProjectIdError, ProjectNotFoundError } from "./errors.js";
import * as fakeFsModule from "node:fs/promises";
import type { Project } from "../types/project.js";

const fakeFs = fakeFsModule as unknown as FakeFs;

// Mirrors projectStore.ts's own PROJECTS_DIR resolution.
const PROJECTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/projects");

// projectDir() only accepts UUID-shaped ids (see projectStore.ts#PROJECT_ID_PATTERN) - every id
// used below to exercise "not found" (as opposed to "rejected outright") must actually look like
// one, same as a real project id minted by createProject's randomUUID().
const VALID_UNKNOWN_ID = "00000000-0000-4000-8000-000000000001";
const VALID_OLDER_ID = "00000000-0000-4000-8000-0000000000aa";
const VALID_NEWER_ID = "00000000-0000-4000-8000-0000000000bb";
const VALID_PROJ_ID = "00000000-0000-4000-8000-0000000000cc";

function seedProject(project: Project) {
  fakeFs.files.set(`${PROJECTS_DIR}/${project.id}/project.json`, JSON.stringify(project));
}

beforeEach(() => {
  fakeFs.files.clear();
});

describe("createProject / getProject / listProjects", () => {
  it("creates a project with a generated id and persists it", async () => {
    const project = await createProject("Recon Alpha", "example.com in scope");

    expect(project.id).toBeTruthy();
    expect(project.name).toBe("Recon Alpha");
    expect(project.notes).toBe("example.com in scope");
    expect(fakeFs.files.has(`${PROJECTS_DIR}/${project.id}/project.json`)).toBe(true);
  });

  it("returns undefined for a well-formed but unknown project id", async () => {
    expect(await getProject(VALID_UNKNOWN_ID)).toBeUndefined();
  });

  it("finds a project that was created", async () => {
    const project = await createProject("Findable", "");
    expect(await getProject(project.id)).toEqual(project);
  });

  it("lists every project sorted by createdAt descending", async () => {
    seedProject({ id: VALID_OLDER_ID, name: "Older", notes: "", createdAt: 1000 });
    seedProject({ id: VALID_NEWER_ID, name: "Newer", notes: "", createdAt: 2000 });

    const projects = await listProjects();
    expect(projects.map((p) => p.id)).toEqual([VALID_NEWER_ID, VALID_OLDER_ID]);
  });

  it("returns an empty list when no projects exist", async () => {
    expect(await listProjects()).toEqual([]);
  });
});

describe("updateProject", () => {
  it("merges only the patched fields", async () => {
    const project = await createProject("Original Name", "original notes");

    const updated = await updateProject(project.id, { notes: "updated notes" });

    expect(updated.name).toBe("Original Name");
    expect(updated.notes).toBe("updated notes");
    expect(await getProject(project.id)).toEqual(updated);
  });

  it("throws ProjectNotFoundError for a well-formed but unknown id", async () => {
    await expect(updateProject(VALID_UNKNOWN_ID, { name: "x" })).rejects.toThrow(ProjectNotFoundError);
  });
});

describe("deleteProject", () => {
  it("removes a project", async () => {
    const project = await createProject("To Delete", "");
    await deleteProject(project.id);
    expect(await getProject(project.id)).toBeUndefined();
  });

  it("throws ProjectNotFoundError deleting an already-deleted (or well-formed but unknown) id", async () => {
    const project = await createProject("To Delete Twice", "");
    await deleteProject(project.id);
    await expect(deleteProject(project.id)).rejects.toThrow(ProjectNotFoundError);
  });
});

// Path-traversal regression coverage: a crafted, non-UUID-shaped id must never reach a real
// filesystem path via projectDir() - see projectStore.ts's PROJECT_ID_PATTERN doc comment.
describe("malformed project ids are rejected before touching disk", () => {
  it("getProject rejects a malformed id instead of treating it as merely 'not found'", async () => {
    await expect(getProject("nope")).rejects.toThrow(InvalidProjectIdError);
  });

  it("getProject rejects a path-traversal attempt", async () => {
    await expect(getProject("../../../../tmp/pwn")).rejects.toThrow(InvalidProjectIdError);
    expect(fakeFs.files.has("/tmp/pwn/project.json")).toBe(false);
  });

  it("updateProject/deleteProject reject a malformed id", async () => {
    await expect(updateProject("../evil", { name: "x" })).rejects.toThrow(InvalidProjectIdError);
    await expect(deleteProject("../evil")).rejects.toThrow(InvalidProjectIdError);
  });

  it("createProject's own generated id is always accepted by projectDir (sanity check)", async () => {
    const project = await createProject("Sanity", "");
    await expect(getProject(project.id)).resolves.toEqual(project);
  });
});

describe("projectStore (readProjectJson/listProjectIds/writeProjectJson)", () => {
  it("returns an empty array for a well-formed but unknown project id", async () => {
    expect(await readProjectJson(VALID_UNKNOWN_ID, "executions.json")).toEqual([]);
    expect(await listProjectIds()).toEqual([]);
  });

  it("returns an empty array for a malformed JSON file instead of throwing", async () => {
    fakeFs.files.set(`${PROJECTS_DIR}/${VALID_PROJ_ID}/executions.json`, "{ not valid json");
    expect(await readProjectJson(VALID_PROJ_ID, "executions.json")).toEqual([]);
  });

  it("round-trips a write then read", async () => {
    await writeProjectJson(VALID_PROJ_ID, "executions.json", [{ id: "a" }, { id: "b" }]);
    expect(await readProjectJson(VALID_PROJ_ID, "executions.json")).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("rejects a malformed id on both read and write, without creating anything on disk", async () => {
    await expect(readProjectJson("../escape", "executions.json")).rejects.toThrow(InvalidProjectIdError);
    await expect(writeProjectJson("../escape", "executions.json", [{ id: "a" }])).rejects.toThrow(
      InvalidProjectIdError,
    );
    expect([...fakeFs.files.keys()].some((f) => f.includes("escape"))).toBe(false);
  });

  it("logs a warning for invalid JSON but stays silent for a plain missing file", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await readProjectJson(VALID_UNKNOWN_ID, "executions.json"); // missing file - no warning expected
    expect(warn).not.toHaveBeenCalled();

    fakeFs.files.set(`${PROJECTS_DIR}/${VALID_PROJ_ID}/executions.json`, "{ not valid json");
    await readProjectJson(VALID_PROJ_ID, "executions.json");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(VALID_PROJ_ID);
    expect(warn.mock.calls[0][0]).toContain("executions.json");

    warn.mockRestore();
  });
});

describe("writeProjectJson serializes overlapping writes to the same project+file", () => {
  it("blocks a second write on the same project+file until the first one's write actually settles", async () => {
    const original = fakeFs.writeFile.bind(fakeFs);
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let writeCalls = 0;
    const writeSpy = vi.spyOn(fakeFs, "writeFile").mockImplementation(async (filePath: string, content: string) => {
      writeCalls++;
      if (writeCalls === 1) await firstGate;
      return original(filePath, content);
    });

    const writeA = writeProjectJson(VALID_PROJ_ID, "executions.json", [{ id: "A (older)" }]);
    const writeB = writeProjectJson(VALID_PROJ_ID, "executions.json", [{ id: "B (newer)" }]);

    // Let pending microtasks settle without releasing A - if writes weren't serialized, B's own
    // writeFile would already have fired by now regardless of A still being held open.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(writeCalls).toBe(1);

    releaseFirst();
    await Promise.all([writeA, writeB]);

    expect(writeCalls).toBe(2);
    expect(await readProjectJson(VALID_PROJ_ID, "executions.json")).toEqual([{ id: "B (newer)" }]);

    writeSpy.mockRestore();
  });

  it("doesn't let two different files for the same project block each other", async () => {
    await Promise.all([
      writeProjectJson(VALID_PROJ_ID, "executions.json", [{ id: "exec" }]),
      writeProjectJson(VALID_PROJ_ID, "tasks.json", [{ id: "task" }]),
    ]);

    expect(await readProjectJson(VALID_PROJ_ID, "executions.json")).toEqual([{ id: "exec" }]);
    expect(await readProjectJson(VALID_PROJ_ID, "tasks.json")).toEqual([{ id: "task" }]);
  });

  it("a failed write doesn't wedge the queue - the next write for the same project+file still runs", async () => {
    const original = fakeFs.writeFile.bind(fakeFs);
    let calls = 0;
    const writeSpy = vi.spyOn(fakeFs, "writeFile").mockImplementation(async (filePath: string, content: string) => {
      calls++;
      if (calls === 1) throw new Error("simulated disk failure");
      return original(filePath, content);
    });

    await expect(writeProjectJson(VALID_PROJ_ID, "executions.json", [{ id: "fails" }])).rejects.toThrow(
      "simulated disk failure",
    );
    await writeProjectJson(VALID_PROJ_ID, "executions.json", [{ id: "succeeds" }]);

    expect(await readProjectJson(VALID_PROJ_ID, "executions.json")).toEqual([{ id: "succeeds" }]);
    writeSpy.mockRestore();
  });
});

describe("readProjectMeta (via getProject) logs a warning for invalid project.json", () => {
  it("logs but still resolves to 'not found' rather than throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fakeFs.files.set(`${PROJECTS_DIR}/${VALID_PROJ_ID}/project.json`, "{ not valid json");

    expect(await getProject(VALID_PROJ_ID)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(VALID_PROJ_ID);

    warn.mockRestore();
  });
});
