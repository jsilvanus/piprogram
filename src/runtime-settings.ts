/**
 * Small JSON settings files in the cache directory, for things an operator changes at runtime (publishing,
 * local audio) so they survive a restart without touching the env files. No cache directory = memory only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export class RuntimeSettingsFile<T extends object> {
  private readonly path: string | null;

  constructor(cacheDir: string | undefined, name: string) {
    this.path = cacheDir ? join(cacheDir, name) : null;
  }

  /** The stored object, or null when there is none or it cannot be read. */
  read(): Partial<T> | null {
    if (!this.path || !existsSync(this.path)) return null;
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      return data && typeof data === "object" && !Array.isArray(data) ? (data as Partial<T>) : null;
    } catch {
      return null;
    }
  }

  write(value: T): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(value, null, 2), "utf8");
  }
}
