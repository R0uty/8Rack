import { describe, expect, it } from "vitest";
import { parse } from "./digParser.js";

const SAMPLE_OUTPUT = `
; <<>> DiG 9.18.1 <<>> example.com
;; global options: +cmd
;; Got answer:
;; QUESTION SECTION:
;example.com.                  IN      A

;; ANSWER SECTION:
example.com.            300     IN      A       93.184.216.34
example.com.            300     IN      A       93.184.216.35

;; Query time: 20 msec
`;

describe("digParser", () => {
  it("extracts an information finding per DNS record in the ANSWER SECTION", () => {
    const findings = parse(SAMPLE_OUTPUT, "example.com");
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ type: "information", value: "A:93.184.216.34", target: "example.com" });
    expect(findings[0].metadata).toMatchObject({ recordType: "A", recordValue: "93.184.216.34" });
  });

  it("returns an empty array when there's no ANSWER SECTION", () => {
    expect(parse(";; no answer", "example.com")).toEqual([]);
  });
});
