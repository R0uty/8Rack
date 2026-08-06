import { describe, expect, it } from "vitest";
import { parse } from "./nucleiParser.js";

describe("nucleiParser", () => {
  it("extracts a potential_vulnerability finding with nuclei's own severity", () => {
    const stdout = "[exposed-panel:admin-login] [http] [medium] https://example.com/wp-login.php\n";
    const findings = parse(stdout, "example.com");

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      type: "potential_vulnerability",
      severity: "medium",
      value: "exposed-panel:admin-login",
      target: "https://example.com/wp-login.php",
      tool: "nuclei",
    });
  });

  it("never emits confirmed_vulnerability", () => {
    const stdout = "[CVE-2021-44228] [http] [critical] https://example.com/\n";
    const findings = parse(stdout, "example.com");
    expect(findings.every((f) => f.type === "potential_vulnerability")).toBe(true);
  });

  it("skips lines with an unrecognized severity token", () => {
    const findings = parse("[template] [http] [not-a-severity] https://example.com/\n", "example.com");
    expect(findings).toEqual([]);
  });

  it("returns an empty array for unrelated text", () => {
    expect(parse("no findings", "example.com")).toEqual([]);
  });
});
