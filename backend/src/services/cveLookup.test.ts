import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetForTests, queryNvd } from "./cveLookup.js";
import { CveLookupError } from "./errors.js";

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  };
}

function fixtureVulnerabilities(cves: unknown[]) {
  return { vulnerabilities: cves.map((cve) => ({ cve })) };
}

/** Advances fake time well past the max throttle interval before awaiting - _resetForTests() in
 * beforeEach means this only ever covers *this* call's own throttle wait, not leaked state. */
async function callQueryNvd(keyword: string) {
  const promise = queryNvd(keyword);
  // Attaches a handler immediately so Node never sees a transient "unhandled rejection" window
  // while advanceTimersByTimeAsync below is what actually lets the rejection occur - the original
  // `promise` (not this .catch()'s derived one) is still what gets returned/asserted on.
  promise.catch(() => {});
  await vi.advanceTimersByTimeAsync(10_000);
  return promise;
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("queryNvd", () => {
  it("returns [] without calling fetch for an empty keyword", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await callQueryNvd("   ")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("extracts severity from cvssMetricV31 when present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          fixtureVulnerabilities([
            {
              id: "CVE-2021-44228",
              descriptions: [{ lang: "en", value: "Log4Shell" }],
              metrics: {
                cvssMetricV31: [{ cvssData: { baseScore: 10.0, baseSeverity: "CRITICAL", vectorString: "CVSS:3.1/..." } }],
              },
              references: [{ url: "https://example.com/advisory" }],
            },
          ]),
        ),
      ),
    );

    const results = await callQueryNvd("log4j-31");
    expect(results).toEqual([
      {
        id: "CVE-2021-44228",
        description: "Log4Shell",
        cvssScore: 10.0,
        cvssSeverity: "critical",
        cvssVector: "CVSS:3.1/...",
        references: ["https://example.com/advisory"],
      },
    ]);
  });

  it("falls back to cvssMetricV2's top-level baseSeverity when no v3 metric exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          fixtureVulnerabilities([
            {
              id: "CVE-2009-2629",
              descriptions: [{ lang: "en", value: "old nginx bug" }],
              metrics: {
                cvssMetricV2: [{ baseSeverity: "HIGH", cvssData: { baseScore: 7.5, vectorString: "AV:N/AC:L/..." } }],
              },
              references: [],
            },
          ]),
        ),
      ),
    );

    const results = await callQueryNvd("nginx-v2");
    expect(results[0]).toMatchObject({ cvssScore: 7.5, cvssSeverity: "high" });
  });

  it("falls back to a score threshold when baseSeverity is absent entirely", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          fixtureVulnerabilities([
            {
              id: "CVE-0000-0001",
              descriptions: [{ lang: "en", value: "d" }],
              metrics: { cvssMetricV2: [{ cvssData: { baseScore: 5.0 } }] },
              references: [],
            },
          ]),
        ),
      ),
    );

    const results = await callQueryNvd("scoreonly");
    expect(results[0]).toMatchObject({ cvssScore: 5.0, cvssSeverity: "medium" });
  });

  it("caches results for the same keyword instead of re-fetching", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fixtureVulnerabilities([])));
    vi.stubGlobal("fetch", fetchMock);

    const keyword = "cache-test-" + Math.random();
    await callQueryNvd(keyword);
    await callQueryNvd(keyword);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throttles requests to stay under NVD's rate limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fixtureVulnerabilities([])));
    vi.stubGlobal("fetch", fetchMock);

    // First call since _resetForTests() needs no throttle wait (lastRequestAt starts at 0), so it
    // resolves on its own without advancing fake time - advancing here would eat into the window
    // the very next call needs to be throttled against.
    const p1 = queryNvd("throttle-a");
    await p1;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const p2 = queryNvd("throttle-b");
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    await p2;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws CveLookupError with a rate-limit message on a 403", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 403 })));
    await expect(callQueryNvd("ratelimited")).rejects.toThrow(CveLookupError);
  });

  it("throws CveLookupError when the network request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(callQueryNvd("networkfail")).rejects.toThrow(CveLookupError);
  });

  it("throws a clear timeout-specific CveLookupError when the request times out", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("timeout"), { name: "TimeoutError" })));
    await expect(callQueryNvd("timesout")).rejects.toThrow(/did not respond in time/i);
  });

  it("passes a bounded AbortSignal on every outbound request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fixtureVulnerabilities([])));
    vi.stubGlobal("fetch", fetchMock);
    await callQueryNvd("bounded");
    const init = fetchMock.mock.calls[0][1] as { signal?: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
