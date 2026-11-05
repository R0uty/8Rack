import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { ScannerPanel } from "./ScannerPanel";
import { useScans } from "../hooks/useScans";

vi.mock("../hooks/useScans", () => ({ useScans: vi.fn() }));

const mockUseScans = vi.mocked(useScans);

function setup() {
  const reset = vi.fn();
  mockUseScans.mockReturnValue({
    profiles: [],
    scans: [],
    run: null,
    liveOutput: [],
    preview: null,
    loading: false,
    previewing: false,
    running: false,
    error: null,
    refresh: vi.fn(),
    runPreview: vi.fn(),
    clearPreview: vi.fn(),
    runScan: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
    reset,
  } as unknown as ReturnType<typeof useScans>);
  return reset;
}

describe("ScannerPanel", () => {
  it("clears any in-flight run/preview when the selected mission changes", () => {
    const reset = setup();
    const { rerender } = render(<ScannerPanel missionId="m1" />);
    expect(reset).toHaveBeenCalledTimes(1);

    rerender(<ScannerPanel missionId="m2" />);
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it("does not stream output while no mission is selected", () => {
    setup();
    render(<ScannerPanel missionId={null} />);
    expect(mockUseScans).toHaveBeenCalledWith(null);
  });
});