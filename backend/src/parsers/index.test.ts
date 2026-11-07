import { describe, expect, it } from "vitest";
import { parseExecutionOutput } from "./index.js";

const DIG_OUTPUT = `
; <<>> DiG 9.18.1 <<>> example.com A
;; ANSWER SECTION:
example.com.            300     IN      A       93.184.216.34
`;

const WHOIS_OUTPUT = `
Domain Name: EXAMPLE.COM
Registry Domain ID: 2336799_DOMAIN_COM-VRSN
Creation Date: 1995-08-14T04:00:00Z
Name Server: NS1.EXAMPLE.COM
`;

describe("parseExecutionOutput terminal output", () => {
  it("strips terminal control sequences before parsing, so they can't end up in finding values", () => {
    const stdout = "\r\u001b[2Kbackup                  [Status: 301, Size: 0, Words: 1, Lines: 1, Duration: 0ms]\u001b[0m\n";

    const [finding] = parseExecutionOutput("ffuf", ["-u", "http://127.0.0.2:8080/FUZZ", "-w", "wordlists/common.txt"], stdout);

    expect(finding.value).toBe("backup");
    expect(finding.title).toBe("backup (301)");
    expect(finding.type).toBe("interesting_file");
  });
});

describe("parseExecutionOutput target attribution", () => {
  it("attributes dig findings to the first non-flag arg, not the query type in last position", () => {
    const findings = parseExecutionOutput("dig", ["example.com", "A"], DIG_OUTPUT);
    expect(findings).toHaveLength(1);
    expect(findings[0].target).toBe("example.com");
  });

  it("attributes whomis findings to the first non-flag arg", () => {
    const findings = parseExecutionOutput("whois", ["example.com"], WHOIS_OUTPUT);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) expect(finding.target).toBe("example.com");
  });
});