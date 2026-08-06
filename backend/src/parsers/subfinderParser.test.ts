import { describe, expect, it } from "vitest";
import { parse } from "./subfinderParser.js";

describe("subfinderParser", () => {
  it("extracts a subdomain finding per line, targeted at the subdomain itself", () => {
    const stdout = "www.example.com\napi.example.com\n";
    const findings = parse(stdout, "example.com");

    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ type: "subdomain", target: "www.example.com", value: "www.example.com" });
    expect(findings[0].metadata).toMatchObject({ parentDomain: "example.com" });
  });

  it("returns an empty array for blank/garbage input", () => {
    expect(parse("\n   \n", "example.com")).toEqual([]);
  });
});
