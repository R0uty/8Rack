import { describe, expect, it } from "vitest";
import { parse } from "./ffufParser.js";

const SAMPLE_OUTPUT = `
        v2.1.0-dev
________________________________________________

 :: Method           : GET
 :: URL              : https://example.com/FUZZ
________________________________________________

admin                   [Status: 200, Size: 1043, Words: 45, Lines: 12, Duration: 121ms]
.git/config             [Status: 200, Size: 92, Words: 5, Lines: 3, Duration: 88ms]
backup.sql              [Status: 403, Size: 278, Words: 10, Lines: 5, Duration: 98ms]
:: Progress: [3/3] :: Job [1/1] :: 50 req/sec :: Duration: [0:00:01] :: Errors: 0 ::
`;

describe("ffufParser", () => {
  it("extracts a directory finding for an ordinary path", () => {
    const findings = parse(SAMPLE_OUTPUT, "https://example.com/FUZZ");
    const admin = findings.find((f) => f.value === "admin");
    expect(admin).toMatchObject({ type: "directory", severity: "info", target: "https://example.com" });
    expect(admin?.metadata).toMatchObject({ status: 200, size: 1043 });
  });

  it("flags sensitive-looking paths as interesting_file with elevated severity", () => {
    const findings = parse(SAMPLE_OUTPUT, "https://example.com/FUZZ");
    const gitConfig = findings.find((f) => f.value === ".git/config");
    const backup = findings.find((f) => f.value === "backup.sql");
    expect(gitConfig).toMatchObject({ type: "interesting_file", severity: "medium" });
    expect(backup).toMatchObject({ type: "interesting_file", severity: "medium" });
  });

  it("returns an empty array for unrelated text", () => {
    expect(parse("no matches here", "https://example.com/FUZZ")).toEqual([]);
  });
});
