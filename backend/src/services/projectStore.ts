import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Every project's data (metadata + scoped history) lives under its own subdirectory here. */
export const PROJECTS_DIR = path.resolve(__dirname, "../../data/projects");

export function projectDir(id: string): string {
  return path.join(PROJECTS_DIR, id);
}

/** Directory names under PROJECTS_DIR, i.e. every project id that has ever been created. */
export async function listProjectIds(): Promise<string[]> {
  try {
    const entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function readProjectJson<T>(id: string, filename: string): Promise<T[]> {
  try {
    const raw = await readFile(path.join(projectDir(id), filename), "utf-8");
    return JSON.parse(raw) as T[];
  } catch {
    return [];
  }
}

export async function writeProjectJson<T>(id: string, filename: string, data: T[]): Promise<void> {
  await mkdir(projectDir(id), { recursive: true });
  await writeFile(path.join(projectDir(id), filename), JSON.stringify(data, null, 2));
}
