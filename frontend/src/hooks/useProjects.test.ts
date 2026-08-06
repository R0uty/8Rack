import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useProjects } from "./useProjects";
import { createProject, deleteProject, fetchProjects, updateProject } from "../services/projectsApi";
import type { Project } from "../types/project";

vi.mock("../services/projectsApi", () => ({
  fetchProjects: vi.fn(),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
}));

const mockFetchProjects = vi.mocked(fetchProjects);
const mockCreateProject = vi.mocked(createProject);
const mockUpdateProject = vi.mocked(updateProject);
const mockDeleteProject = vi.mocked(deleteProject);

const fixtureProject: Project = { id: "p1", name: "Acme", notes: "scope notes", createdAt: 0 };

describe("useProjects", () => {
  it("loads projects on mount", async () => {
    mockFetchProjects.mockResolvedValue([fixtureProject]);
    const { result } = renderHook(() => useProjects());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.projects).toEqual([fixtureProject]);
  });

  it("surfaces a load failure", async () => {
    mockFetchProjects.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useProjects());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("boom");
  });

  it("create() creates then re-fetches the list", async () => {
    mockFetchProjects.mockResolvedValueOnce([]).mockResolvedValueOnce([fixtureProject]);
    mockCreateProject.mockResolvedValue(fixtureProject);
    const { result } = renderHook(() => useProjects());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let created: Project | undefined;
    await act(async () => {
      created = await result.current.create("Acme", "scope notes");
    });

    expect(mockCreateProject).toHaveBeenCalledWith("Acme", "scope notes");
    expect(created).toEqual(fixtureProject);
    expect(result.current.projects).toEqual([fixtureProject]);
  });

  it("update() patches then re-fetches the list", async () => {
    mockFetchProjects.mockResolvedValue([fixtureProject]);
    const updated = { ...fixtureProject, name: "Renamed" };
    mockUpdateProject.mockResolvedValue(updated);
    const { result } = renderHook(() => useProjects());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockFetchProjects.mockResolvedValueOnce([updated]);
    await act(async () => {
      await result.current.update("p1", { name: "Renamed" });
    });

    expect(mockUpdateProject).toHaveBeenCalledWith("p1", { name: "Renamed" });
    expect(result.current.projects).toEqual([updated]);
  });

  it("remove() deletes then re-fetches the list", async () => {
    mockFetchProjects.mockResolvedValueOnce([fixtureProject]).mockResolvedValueOnce([]);
    mockDeleteProject.mockResolvedValue(undefined);
    const { result } = renderHook(() => useProjects());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.remove("p1");
    });

    expect(mockDeleteProject).toHaveBeenCalledWith("p1");
    expect(result.current.projects).toEqual([]);
  });
});
