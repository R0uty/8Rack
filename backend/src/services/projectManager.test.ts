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
import { ProjectNotFoundError } from "./errors.js";
import * as fakeFsModule from "node:fs/promises";
import type { Project } from "../types/project.js";

const fakeFs = fakeFsModule as unknown as FakeFs;

// Mirrors projectStore.ts's own PROJECTS_DIR resolution.
const PROJECTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/projects");

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

  it("returns undefined for an unknown project id", async () => {
    expect(await getProject("nope")).toBeUndefined();
  });

  it("finds a project that was created", async () => {
    const project = await createProject("Findable", "");
    expect(await getProject(project.id)).toEqual(project);
  });

  it("lists every project sorted by createdAt descending", async () => {
    seedProject({ id: "older", name: "Older", notes: "", createdAt: 1000 });
    seedProject({ id: "newer", name: "Newer", notes: "", createdAt: 2000 });

    const projects = await listProjects();
    expect(projects.map((p) => p.id)).toEqual(["newer", "older"]);
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

  it("throws ProjectNotFoundError for an unknown id", async () => {
    await expect(updateProject("nope", { name: "x" })).rejects.toThrow(ProjectNotFoundError);
  });
});

describe("deleteProject", () => {
  it("removes a project", async () => {
    const project = await createProject("To Delete", "");
    await deleteProject(project.id);
    expect(await getProject(project.id)).toBeUndefined();
  });

  it("throws ProjectNotFoundError deleting an already-deleted (or unknown) id", async () => {
    const project = await createProject("To Delete Twice", "");
    await deleteProject(project.id);
    await expect(deleteProject(project.id)).rejects.toThrow(ProjectNotFoundError);
  });
});

describe("projectStore (readProjectJson/listProjectIds/writeProjectJson)", () => {
  it("returns an empty array for a project directory that doesn't exist", async () => {
    expect(await readProjectJson("nope", "executions.json")).toEqual([]);
    expect(await listProjectIds()).toEqual([]);
  });

  it("returns an empty array for a malformed JSON file instead of throwing", async () => {
    fakeFs.files.set(`${PROJECTS_DIR}/proj/executions.json`, "{ not valid json");
    expect(await readProjectJson("proj", "executions.json")).toEqual([]);
  });

  it("round-trips a write then read", async () => {
    await writeProjectJson("proj", "executions.json", [{ id: "a" }, { id: "b" }]);
    expect(await readProjectJson("proj", "executions.json")).toEqual([{ id: "a" }, { id: "b" }]);
  });
});
