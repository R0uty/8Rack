import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { getMission } from "../services/missionManager.js";
import { MissionNotFoundError } from "../services/errors.js";
import { requireMission } from "./requireMission.js";

vi.mock("../services/missionManager.js", () => ({ getMission: vi.fn() }));
const mockGetMission = vi.mocked(getMission);

async function run(req: Partial<Request>) {
  const next = vi.fn();
  await requireMission({ params: {}, body: {}, ...req } as Request, {} as Response, next);
  return next;
}

describe("requireMission", () => {
  it("rejects a write to a mission that doesn't exist", async () => {
    mockGetMission.mockResolvedValueOnce(undefined);
    const next = await run({ method: "POST", params: { missionId: "m" } });
    expect(next.mock.calls[0][0]).toBeInstanceOf(MissionNotFoundError);
  });

  it("checks a missionId given in the body too", async () => {
    mockGetMission.mockResolvedValueOnce(undefined);
    const next = await run({ method: "POST", body: { missionId: "m" } });
    expect(next.mock.calls[0][0]).toBeInstanceOf(MissionNotFoundError);
  });

  it("lets a write to an existing mission through", async () => {
    mockGetMission.mockResolvedValueOnce({ id: "m" } as never);
    const next = await run({ method: "POST", params: { missionId: "m" } });
    expect(next).toHaveBeenCalledWith(undefined);
  });

  it("passes a malformed id's rejection on to the error handler", async () => {
    const invalid = new Error("invalid id");
    mockGetMission.mockRejectedValueOnce(invalid);
    const next = await run({ method: "POST", params: { missionId: "../x" } });
    expect(next).toHaveBeenCalledWith(invalid);
  });

  it("leaves reads, and bodies with no usable missionId for the route's own validation", async () => {
    mockGetMission.mockClear();
    await run({ method: "GET", params: { missionId: "m" } });
    await run({ method: "POST", body: { missionId: 7 } });
    expect(mockGetMission).not.toHaveBeenCalled();
  });
});
