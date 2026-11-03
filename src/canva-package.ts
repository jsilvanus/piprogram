/**
 * Turns an export package from Canva (a zip of page images, or the pages as JSON) into the ordered
 * list of page images piprogram stores.
 */

import { randomUUID } from "node:crypto";
import type { PiPgmOrientation } from "./pipgm-model.js";
import type { PiPgmService } from "./pipgm-service.js";
import type { StepImages } from "./step-cache.js";
import { readZip, type ZipLimits } from "./zip.js";

export interface PackagePage {
  pageNumber: number;
  filename: string;
  mimeType: string;
  data: Buffer;
}

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

export function imageTypeOf(filename: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  return ext ? IMAGE_TYPES[ext] ?? null : null;
}

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

/**
 * Numbers the pages by the last number in each file name (page-2 before page-10) when every image
 * has one and they are all different; otherwise by natural file name order.
 */
export function numberPages(files: Array<{ filename: string; mimeType: string; data: Buffer }>): PackagePage[] {
  const numbered = files.map((f) => {
    const stem = baseName(f.filename).replace(/\.[^.]+$/, "");
    const digits = stem.match(/\d+/g);
    return { ...f, num: digits ? Number(digits[digits.length - 1]) : null };
  });
  const nums = numbered.map((f) => f.num);
  const usable = nums.every((n) => n !== null) && new Set(nums).size === nums.length;
  const sorted = [...numbered].sort((a, b) =>
    usable ? (a.num as number) - (b.num as number) : baseName(a.filename).localeCompare(baseName(b.filename), "en", { numeric: true })
  );
  return sorted.map((f, i) => ({
    pageNumber: usable ? (f.num as number) : i + 1,
    filename: baseName(f.filename),
    mimeType: f.mimeType,
    data: f.data
  }));
}

/** The page images of a zip. Folders, hidden files (`__MACOSX`, dot files) and other file types are ignored. */
export function pagesFromZip(zip: Buffer, limits?: ZipLimits): PackagePage[] {
  const images = readZip(zip, limits)
    .filter((e) => !e.name.split("/").some((part) => part.startsWith(".") || part === "__MACOSX"))
    .flatMap((e) => {
      const mimeType = imageTypeOf(e.name);
      return mimeType ? [{ filename: e.name, mimeType, data: e.data }] : [];
    });
  return numberPages(images);
}

// ---- Tasks: the package is accepted at once and worked on in the background ----------------------

export type PackageTaskState = "queued" | "unpacking" | "preparing" | "ready" | "failed";

export interface PackageTask {
  taskId: string;
  type: "canva-package";
  itemId: string;
  state: PackageTaskState;
  /** 0 to 1 over the whole job: unpacking, then the step pictures and thumbnails. */
  progress: number;
  pages: { total: number };
  /** Step pictures with their thumbnails made, over all requested orientations. */
  pictures: { done: number; total: number };
  orientations: PiPgmOrientation[];
  /** True when the item and its page files are stored in the library store (not needed for it to be ready for air). */
  saved: boolean;
  /** True when the item can go on air with its pictures prepared. */
  ready: boolean;
  error: string | null;
  startedAt: string;
  updatedAt: string;
}

export type PackageSource = { zip: Buffer } | { pages: PackagePage[] };

export interface CanvaPackagesOptions {
  service: PiPgmService;
  steps: StepImages;
  pollMs?: number | undefined;
  /** Finished tasks kept for lookup (default 50). */
  keep?: number | undefined;
  now?: (() => number) | undefined;
}

export class CanvaPackages {
  private readonly tasks = new Map<string, PackageTask>();
  private readonly pollMs: number;
  private readonly keep: number;
  private readonly now: () => number;

  constructor(private readonly options: CanvaPackagesOptions) {
    this.pollMs = options.pollMs ?? 100;
    this.keep = options.keep ?? 50;
    this.now = options.now ?? Date.now;
  }

  get(taskId: string): PackageTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    return { ...task, saved: this.options.service.isItemSaved(task.itemId) };
  }

  /** Accepts a package for a Canva item. Returns the new task, or why it was refused. */
  accept(itemId: string, source: PackageSource, orientations: PiPgmOrientation[] = ["landscape"]): PackageTask | "ITEM_NOT_FOUND" | "NOT_CANVA_ITEM" | "BUSY" {
    const item = this.options.service.getLibraryItem(itemId);
    if (!item) return "ITEM_NOT_FOUND";
    if (item.kind !== "canva") return "NOT_CANVA_ITEM";
    for (const task of this.tasks.values()) {
      if (task.itemId === itemId && task.state !== "ready" && task.state !== "failed") return "BUSY";
    }
    const stamp = new Date(this.now()).toISOString();
    const task: PackageTask = {
      taskId: randomUUID(),
      type: "canva-package",
      itemId,
      state: "queued",
      progress: 0,
      pages: { total: 0 },
      pictures: { done: 0, total: 0 },
      orientations,
      saved: false,
      ready: false,
      error: null,
      startedAt: stamp,
      updatedAt: stamp
    };
    this.tasks.set(task.taskId, task);
    while (this.tasks.size > this.keep) {
      const oldest = [...this.tasks.values()].find((t) => t.state === "ready" || t.state === "failed");
      if (!oldest) break;
      this.tasks.delete(oldest.taskId);
    }
    void this.run(task, source);
    return this.get(task.taskId)!;
  }

  private touch(task: PackageTask, patch: Partial<PackageTask>): void {
    Object.assign(task, patch, { updatedAt: new Date(this.now()).toISOString() });
  }

  private async run(task: PackageTask, source: PackageSource): Promise<void> {
    try {
      this.touch(task, { state: "unpacking", progress: 0.05 });
      await new Promise((r) => setImmediate(r));
      const pages = "zip" in source ? pagesFromZip(source.zip) : source.pages;
      if (pages.length === 0) throw new Error("the package has no page images (png, jpg or webp)");
      const attached = this.options.service.attachCanvaPages(task.itemId, pages);
      if (typeof attached === "string") throw new Error(`the item is gone (${attached})`);
      const total = attached.steps.length * task.orientations.length;
      this.touch(task, { state: "preparing", progress: 0.1, pages: { total: pages.length }, pictures: { done: 0, total } });

      let finished = 0;
      for (const orientation of task.orientations) {
        const started = this.options.steps.prepare(task.itemId, orientation);
        if (typeof started === "string") throw new Error(`cannot prepare pictures (${started})`);
        for (;;) {
          const status = this.options.steps.status(task.itemId, orientation);
          const done = finished + status.done;
          this.touch(task, { pictures: { done, total }, progress: 0.1 + 0.9 * (total ? done / total : 1) });
          if (status.state === "failed") throw new Error(status.error ?? "preparing the pictures failed");
          if (status.state === "done") break;
          await new Promise((r) => setTimeout(r, this.pollMs));
        }
        finished += attached.steps.length;
      }
      this.touch(task, { state: "ready", ready: true, progress: 1, pictures: { done: total, total } });
    } catch (error) {
      this.touch(task, { state: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }
}
