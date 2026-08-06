import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// framer-motion (used by Collapsible, view transitions) probes matchMedia for reduced-motion;
// jsdom doesn't implement it at all.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.resetAllMocks();
});

afterEach(() => {
  cleanup();
});
