import { describe, expect, it } from "vitest";
import { checkScope, extractTargets, isInScope, isTargetOutOfScope } from "./scopeMatcher.js";

describe("extractTargets", () => {
  it("extracts a bare domain", () => {
    expect(extractTargets(["dig", "example.com"])).toEqual(["example.com"]);
  });

  it("extracts an IPv4 address", () => {
    expect(extractTargets(["nmap", "-sV", "10.0.0.5"])).toEqual(["10.0.0.5"]);
  });

  it("extracts a hostname out of a URL, not the whole URL", () => {
    expect(extractTargets(["curl", "https://example.com/path?x=1"])).toEqual(["example.com"]);
  });

  it("extracts a target embedded inside a shell string", () => {
    expect(extractTargets(["-c", "curl https://api.example.com/v1"])).toEqual(["api.example.com"]);
  });

  it("returns nothing for arguments with no target-shaped tokens", () => {
    expect(extractTargets(["-la"])).toEqual([]);
    expect(extractTargets(["-c", "whoami"])).toEqual([]);
  });

  it("does not mistake dotted code identifiers or filenames for domains", () => {
    expect(extractTargets(["-c", "process.stdout.write('x')"])).toEqual([]);
    expect(extractTargets(["-c", "import matplotlib.pyplot as plt"])).toEqual([]);
    expect(extractTargets(["cat", "config.yaml"])).toEqual([]);
    expect(extractTargets(["python3", "app.py"])).toEqual([]);
  });

  it("deduplicates the same target seen multiple times", () => {
    expect(extractTargets(["example.com", "example.com"])).toEqual(["example.com"]);
  });

  it("never double-counts an IP as also matching the domain pattern", () => {
    const targets = extractTargets(["10.0.0.5"]);
    expect(targets).toEqual(["10.0.0.5"]);
  });
});

describe("isInScope", () => {
  it("matches an exact domain", () => {
    expect(isInScope("example.com", ["example.com"])).toBe(true);
    expect(isInScope("other.com", ["example.com"])).toBe(false);
  });

  it("matches a subdomain against its bare parent domain", () => {
    expect(isInScope("api.example.com", ["example.com"])).toBe(true);
  });

  it("does not let a substring-only match count (e.g. evilexample.com vs example.com)", () => {
    expect(isInScope("evilexample.com", ["example.com"])).toBe(false);
  });

  it("matches a wildcard subdomain entry", () => {
    expect(isInScope("api.example.com", ["*.example.com"])).toBe(true);
    expect(isInScope("example.com", ["*.example.com"])).toBe(true);
    expect(isInScope("other.com", ["*.example.com"])).toBe(false);
  });

  it("matches an IP inside a CIDR range", () => {
    expect(isInScope("10.0.0.5", ["10.0.0.0/24"])).toBe(true);
    expect(isInScope("10.0.1.5", ["10.0.0.0/24"])).toBe(false);
  });

  it("matches a URL entry by hostname", () => {
    expect(isInScope("example.com", ["https://example.com/"])).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isInScope("Example.COM", ["example.com"])).toBe(true);
  });
});

describe("isTargetOutOfScope", () => {
  it("is never out of scope when neither scope nor outOfScope is configured", () => {
    expect(isTargetOutOfScope(undefined, undefined, "anything.com")).toBe(false);
  });

  it("blocks a target that isn't in a configured scope allowlist", () => {
    expect(isTargetOutOfScope(["example.com"], undefined, "other.com")).toBe(true);
    expect(isTargetOutOfScope(["example.com"], undefined, "example.com")).toBe(false);
  });

  it("blocks a target explicitly listed in outOfScope even if scope is empty", () => {
    expect(isTargetOutOfScope(undefined, ["evil.com"], "evil.com")).toBe(true);
  });

  it("outOfScope wins over a broader scope match (carve-out)", () => {
    expect(isTargetOutOfScope(["*.example.com"], ["staging.example.com"], "staging.example.com")).toBe(true);
    expect(isTargetOutOfScope(["*.example.com"], ["staging.example.com"], "api.example.com")).toBe(false);
  });
});

describe("checkScope", () => {
  it("returns no_restriction when the mission has no scope configured at all", () => {
    expect(checkScope(undefined, undefined, ["nmap", "10.0.0.5"])).toEqual({ verdict: "no_restriction" });
  });

  it("returns unknown when scope is configured but no target-shaped token is found", () => {
    expect(checkScope(["example.com"], undefined, ["-c", "whoami"])).toEqual({ verdict: "unknown" });
  });

  it("returns in_scope when every extracted target matches", () => {
    const result = checkScope(["example.com"], undefined, ["curl", "https://example.com"]);
    expect(result).toEqual({ verdict: "in_scope", targets: ["example.com"] });
  });

  it("returns out_of_scope with the offending target(s) when any extracted target doesn't match", () => {
    const result = checkScope(["example.com"], undefined, ["curl", "https://evil.com"]);
    expect(result).toEqual({ verdict: "out_of_scope", offending: ["evil.com"] });
  });

  it("returns out_of_scope for an explicitly excluded target even with a broad scope", () => {
    const result = checkScope(["*.example.com"], ["staging.example.com"], ["curl", "https://staging.example.com"]);
    expect(result).toEqual({ verdict: "out_of_scope", offending: ["staging.example.com"] });
  });
});
