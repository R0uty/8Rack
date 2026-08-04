import type { Scanner } from "../types/scanner.js";

const scanners = new Map<string, Scanner>();

export function registerScanner(scanner: Scanner): void {
  scanners.set(scanner.id, scanner);
}

export function getScanner(id: string): Scanner | undefined {
  return scanners.get(id);
}

export function listScanners(): Pick<Scanner, "id" | "name" | "description">[] {
  return [...scanners.values()].map(({ id, name, description }) => ({ id, name, description }));
}
