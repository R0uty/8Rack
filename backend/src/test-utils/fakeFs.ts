/**
 * A minimal in-memory double for the handful of `node:fs/promises` functions this codebase
 * actually uses (`mkdir`/`readFile`/`writeFile`/`readdir`/`rm`), for tests that exercise
 * agentManager.ts/missionManager.ts/missionStore.ts without touching the real filesystem. Files
 * are stored as full-path -> content entries; directories are inferred from path prefixes, so
 * `mkdir` is a no-op and `readdir` distinguishes "file directly here" from "nested under a
 * subdirectory here" by whether more path segments follow.
 */
export interface FakeFs {
  files: Map<string, string>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<string | undefined>;
  readFile(path: string, encoding?: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  readdir(path: string, opts?: { withFileTypes?: boolean }): Promise<string[] | FakeDirent[]>;
  rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

export interface FakeDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

function enoent(path: string): NodeJS.ErrnoException {
  const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

export function createFakeFs(): FakeFs {
  const files = new Map<string, string>();

  return {
    files,

    async mkdir() {
      return undefined;
    },

    async readFile(path: string) {
      const content = files.get(path);
      if (content === undefined) throw enoent(path);
      return content;
    },

    async writeFile(path: string, content: string) {
      files.set(path, content);
    },

    async readdir(path: string, opts?: { withFileTypes?: boolean }) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const entries = new Map<string, boolean>(); // name -> isDirectory

      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) {
          entries.set(rest, entries.get(rest) ?? false);
        } else {
          entries.set(rest.slice(0, slash), true);
        }
      }

      const names = [...entries.keys()];
      if (!opts?.withFileTypes) return names;
      return names.map((name) => {
        const isDir = entries.get(name) ?? false;
        return { name, isDirectory: () => isDir, isFile: () => !isDir };
      });
    },

    async rm(path: string) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      for (const key of [...files.keys()]) {
        if (key === path || key.startsWith(prefix)) files.delete(key);
      }
    },
  };
}
