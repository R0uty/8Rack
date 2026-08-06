import { describe, expect, it } from "vitest";
import { parse } from "./nmapParser.js";

const SAMPLE_OUTPUT = `
Starting Nmap 7.94 ( https://nmap.org ) at 2024-01-01 12:00 UTC
Nmap scan report for example.com (93.184.216.34)
Host is up (0.023s latency).
Not shown: 997 closed tcp ports (reset)
PORT    STATE  SERVICE
22/tcp  open   ssh
80/tcp  open   http
443/tcp closed https

Nmap done: 1 IP address (1 host up) scanned in 1.23 seconds
`;

describe("nmapParser", () => {
  it("extracts a port + service finding for each open port", () => {
    const findings = parse(SAMPLE_OUTPUT, "example.com");
    const ports = findings.filter((f) => f.type === "port");
    const services = findings.filter((f) => f.type === "service");

    expect(ports.map((p) => p.value)).toEqual(["22/tcp", "80/tcp"]);
    expect(services.map((s) => s.value)).toEqual(["22/tcp:ssh", "80/tcp:http"]);
    expect(ports[0].target).toBe("example.com");
    expect(ports[0].metadata).toMatchObject({ port: 22, protocol: "tcp", service: "ssh" });
  });

  it("skips closed ports", () => {
    const findings = parse(SAMPLE_OUTPUT, "example.com");
    expect(findings.some((f) => f.value.startsWith("443"))).toBe(false);
  });

  it("returns an empty array for unrelated text", () => {
    expect(parse("nothing to see here", "example.com")).toEqual([]);
  });
});
