import { describe, expect, it } from "vitest";
import { classifyScopeLine, classifyScopeText } from "./scopeLines";

describe("classifyScopeLine", () => {
  it.each([
    ["example.com", "domain"],
    ["*.example.com", "wildcard"],
    ["10.0.0.5", "ip"],
    ["10.0.0.0/24", "cidr"],
    ["2001:db8::/32", "cidr"],
    ["https://app.example.com", "url"],
    ["example.com:8443", "host-port"],
    ["::1", "ipv6"],
    ["example.com/admin", "unrecognized"],
    ["not a target", "unrecognized"],
    ["10.0.0.0/40", "unrecognized"],
  ])("reads %s as %s", (line, kind) => {
    expect(classifyScopeLine(line).kind).toBe(kind);
  });

  it("says how big a CIDR range is", () => {
    expect(classifyScopeLine("10.0.0.0/24").meaning).toContain("256 addresses");
  });

  it("warns that ports and paths are not enforced", () => {
    expect(classifyScopeLine("example.com:8443").warning).toMatch(/port/);
    expect(classifyScopeLine("https://example.com/api").warning).toMatch(/Paths/);
    expect(classifyScopeLine("https://example.com").warning).toBeUndefined();
  });

  it("flags lines that match nothing", () => {
    expect(classifyScopeLine("foo bar").warning).toMatch(/match nothing/);
  });
});

describe("classifyScopeText", () => {
  it("skips blank lines", () => {
    expect(classifyScopeText("a.com\n\n  \nb.com").map((l) => l.line)).toEqual(["a.com", "b.com"]);
  });
});
