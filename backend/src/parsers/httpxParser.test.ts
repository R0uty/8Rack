import { describe, expect, it } from "vitest";
import { parse } from "./httpxParser.js";

describe("httpxParser", () => {
  it("extracts an endpoint finding per live URL", () => {
    const stdout = "https://example.com\nhttps://sub.example.com\n";
    const findings = parse(stdout, "example.com");

    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ type: "endpoint", value: "https://example.com", tool: "httpx" });
    expect(findings[1].value).toBe("https://sub.example.com");
  });

  it("ignores blank lines and non-URL noise", () => {
    const findings = parse("\n\nnot a url\n", "example.com");
    expect(findings).toEqual([]);
  });
});
