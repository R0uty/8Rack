import { describe, expect, it } from "vitest";
import { parse } from "./katanaParser.js";

describe("katanaParser", () => {
  it("extracts an endpoint finding per crawled URL", () => {
    const stdout = "https://example.com/\nhttps://example.com/about\n";
    const findings = parse(stdout, "example.com");

    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ type: "endpoint", tool: "katana", value: "https://example.com/" });
  });

  it("returns an empty array for empty input", () => {
    expect(parse("", "example.com")).toEqual([]);
  });
});
