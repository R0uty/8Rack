/**
 * Small request-body checks shared by the routes. Every route still validates by hand (no schema
 * library - the bodies are small and the 400 messages are part of the API), but the enum checks all
 * go through `isOneOf` against the lists exported from types/, so a new value is added in one place.
 */

export function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

export function oneOfMessage(field: string, allowed: readonly string[]): string {
  return `${field} must be one of: ${allowed.join(", ")}`;
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}
