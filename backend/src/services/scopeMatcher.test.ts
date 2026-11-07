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

  it("extracts a bare IPv6 address", () => {
    expect(extractTargets(["ping6", "::1"])).toEqual(["::1"]);
    expect(extractTargets(["nmap", "-6", "fe80::1"])).toEqual(["fe80::1"]);
  });

  it("extracts the bracketed IPv6 host out of a URL, without the brackets", () => {
    expect(extractTargets(["curl", "http://[::1]:8080/path"])).toEqual(["::1"]);
  });

  it("normalizes decimal/hex/octal alternate IPv4 forms embedded in a URL", () => {
    expect(extractTargets(["curl", "http://2130706433/"])).toEqual(["127.0.0.1"]);
    expect(extractTargets(["curl", "http://0x7f000001/"])).toEqual(["127.0.0.1"]);
  });

  it("does not mistake a host:port suffix for an IPv6 address", () => {
    expect(extractTargets(["curl", "example.com:8443"])).toEqual(["example.com"]);
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

  it("matches an exact IPv6 address regardless of compression/case", () => {
    expect(isInScope("::1", ["::1"])).toBe(true);
    expect(isInScope("0:0:0:0:0:0:0:1", ["::1"])).toBe(true);
    expect(isInScope("FE80::1", ["fe80::1"])).toBe(true);
    expect(isInScope("::2", ["::1"])).toBe(false);
  });

  it("matches an IPv6 address inside a CIDR range", () => {
    expect(isInScope("2001:db8::1", ["2001:db8::/32"])).toBe(true);
    expect(isInScope("2001:db9::1", ["2001:db8::/32"])).toBe(false);
  });

  it("matches a scope entry that includes a port by host only", () => {
    expect(isInScope("example.com", ["example.com:8080"])).toBe(true);
    expect(isInScope("10.0.0.5", ["10.0.0.5:22"])).toBe(true);
    expect(isInScope("other.com", ["example.com:8080"])).toBe(false);
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

describe("targets on a TLD outside the built-in list", () => {
  it("still blocks an out-of-scope host whose TLD only the mission's own entries know", () => {
    expect(checkScope(["acme.gg"], ["admin.acme.gg"], ["curl", "admin.acme.gg"]).verdict).toBe("out_of_scope");
  });

  it("recognizes in-scope targets on an internal TLD", () => {
    expect(checkScope(["*.corp.internal"], undefined, ["nmap", "app.corp.internal"]).verdict).toBe("in_scope");
  });

  it("blocks a sibling on that same TLD that isn't in scope", () => {
    expect(checkScope(["*.corp.internal"], undefined, ["nmap", "evil.internal"]).verdict).toBe("out_of_scope");
  });

  it("doesn't treat a filename as a target just because scope is configured", () => {
    expect(extractTargets(["cat", "notes.txt"], new Set(["gg"]))).toEqual([]);
  });
});

describe("host normalization", () => {
  it("treats a fully-qualified trailing dot as the same host", () => {
    expect(isTargetOutOfScope(undefined, ["admin.example.com"], "admin.example.com.")).toBe(true);
    expect(isInScope("app.example.com.", ["*.example.com"])).toBe(true);
    expect(checkScope(["example.com"], ["admin.example.com"], ["curl", "https://admin.example.com./x"]).verdict).toBe("out_of_scope");
  });

  it("doesn't read code-like tokens as IPv6 targets", () => {
    expect(extractTargets(["std::cout"])).toEqual([]);
    expect(extractTargets(["curl", "http://[2001:db8::1]/"])).toContain("2001:db8::1");
    expect(extractTargets(["nmap", "2001:db8::1"])).toContain("2001:db8::1");
  });
});
