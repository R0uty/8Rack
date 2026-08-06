import { describe, expect, it } from "vitest";
import { parse } from "./whoisParser.js";

const SAMPLE_OUTPUT = `
Domain Name: EXAMPLE.COM
Registrar: RESERVED-Internet Assigned Numbers Authority
Updated Date: 2023-08-14T07:01:38Z
Creation Date: 1995-08-14T04:00:00Z
Registry Expiry Date: 2024-08-13T04:00:00Z
Name Server: A.IANA-SERVERS.NET
Name Server: B.IANA-SERVERS.NET
DNSSEC: signedDelegation
`;

describe("whoisParser", () => {
  it("extracts only the curated interesting fields", () => {
    const findings = parse(SAMPLE_OUTPUT, "example.com");
    const keys = findings.map((f) => f.metadata?.key);

    expect(keys).toContain("Registrar");
    expect(keys).toContain("Creation Date");
    expect(keys).not.toContain("Domain Name");
  });

  it("keeps both Name Server lines as separate findings", () => {
    const findings = parse(SAMPLE_OUTPUT, "example.com");
    const nameServers = findings.filter((f) => f.metadata?.key === "Name Server");
    expect(nameServers).toHaveLength(2);
  });

  it("returns an empty array for unrelated text", () => {
    expect(parse("no colons here", "example.com")).toEqual([]);
  });
});
