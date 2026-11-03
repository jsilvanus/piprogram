/**
 * Prepared pictures of the steps of an item (a slide of a .pptx, a stanza of a hymn, an image), kept
 * in the library store (pistorage) so that the next time a step goes on air its picture is read,
 * not rendered by a browser, and so that the UI has thumbnails to show.
 *
 * Keys: <prefix>/<itemId>/<version>/<orientation>/<step>.png and <step>.thumb.jpg, where <version>
 * is a hash of what the picture depends on (the item's steps and the output size). An edited item
 * has a new version, so a stale picture is never used; old versions are removed when a new one is
 * prepared. Thumbnails are made here (ffmpeg scales the PNG), not in pistorage, which only moves bytes.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { BlobStore } from "./library-store.js";
import type { PipgmFrameRenderer } from "./frame.js";
import { getResolutionForOrientation, type PiPgmItem, type PiPgmOrientation, type PiPgmPipelineSnapshot } from "./pipgm-model.js";
import { renderPiPgmStageHtml } from "./stage-html.js";

/** Item kinds whose steps are still pictures. Video, audio and YouTube are not. */
export const STILL_KINDS: ReadonlySet<string> = new Set(["pptx", "hymn", "image", "canva"]);
export const THUMBNAIL_WIDTH = 320;

export type Thumbnailer = (png: Buffer) => Promise<Buffer>;

/** Scales a PNG to a small JPEG with ffmpeg (already needed for the feeds). */
export function ffmpegThumbnailer(ffmpeg = process.env.PIPGM_FFMPEG?.trim() || "ffmpeg", timeoutMs = 20_000): Thumbnailer {
  return (png) =>
    new Promise<Buffer>((resolve, reject) => {
      const child = spawn(
        ffmpeg,
        ["-loglevel", "error", "-f", "image2pipe", "-c:v", "png", "-i", "pipe:0", "-vf", `scale=${THUMBNAIL_WIDTH}:-2`, "-frames:v", "1", "-q:v", "5", "-f", "mjpeg", "pipe:1"],
        { stdio: ["pipe", "pipe", "pipe"] }
      );
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", (c: Buffer) => out.push(c));
      child.stderr.on("data", (c: Buffer) => err.push(c));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const jpg = Buffer.concat(out);
        if (code === 0 && jpg.length > 0) resolve(jpg);
        else reject(new Error(`thumbnail failed (ffmpeg exit ${code}): ${Buffer.concat(err).toString("utf8").slice(0, 200)}`));
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(png);
    });
}

export function itemVersion(item: PiPgmItem, orientation: PiPgmOrientation): string {
  const { width, height } = getResolutionForOrientation(orientation);
  return createHash("sha256")
    .update(JSON.stringify([item.kind, item.title, item.steps, width, height]))
    .digest("hex")
    .slice(0, 16);
}

export interface StepInfo {
  step: number;
  label: string;
  prepared: boolean;
}

export type PrepareState = { state: "idle" | "running" | "done" | "failed"; done: number; total: number; error: string | null };

export interface StepImagesOptions {
  store: BlobStore;
  renderFrame: PipgmFrameRenderer;
  /** A pipeline snapshot showing the given step of the item, without touching a real pipeline. */
  snapshotForStep: (itemId: string, step: number, orientation: PiPgmOrientation) => PiPgmPipelineSnapshot | null;
  getItem: (itemId: string) => PiPgmItem | undefined;
  thumbnailer?: Thumbnailer | undefined;
  prefix?: string | undefined;
}

export class StepImages {
  private readonly store: BlobStore;
  private readonly prefix: string;
  private readonly thumbnailer: Thumbnailer;
  private readonly jobs = new Map<string, PrepareState>();

  constructor(private readonly options: StepImagesOptions) {
    this.store = options.store;
    this.prefix = options.prefix ?? "piprogram/steps";
    this.thumbnailer = options.thumbnailer ?? ffmpegThumbnailer();
  }

  private key(item: PiPgmItem, orientation: PiPgmOrientation, step: number, thumb: boolean): string {
    return `${this.prefix}/${item.id}/${itemVersion(item, orientation)}/${orientation}/${step}${thumb ? ".thumb.jpg" : ".png"}`;
  }

  /** The prepared PNG of a step, or null. A store problem is a miss (the caller renders instead). */
  async image(itemId: string, step: number, orientation: PiPgmOrientation): Promise<Buffer | null> {
    return this.read(itemId, step, orientation, false);
  }

  async thumbnail(itemId: string, step: number, orientation: PiPgmOrientation): Promise<Buffer | null> {
    return this.read(itemId, step, orientation, true);
  }

  private async read(itemId: string, step: number, orientation: PiPgmOrientation, thumb: boolean): Promise<Buffer | null> {
    const item = this.options.getItem(itemId);
    if (!item || !STILL_KINDS.has(item.kind) || !item.steps[step]) return null;
    try {
      return await this.store.get(this.key(item, orientation, step, thumb));
    } catch {
      return null;
    }
  }

  /** The picture of the step on air in a snapshot, if it was prepared. */
  async lookup(snapshot: PiPgmPipelineSnapshot): Promise<Buffer | null> {
    if (!snapshot.activeItemId) return null;
    return this.image(snapshot.activeItemId, snapshot.currentStep, snapshot.orientation);
  }

  /** Keeps a picture that was rendered for air, so the next time it is read. Never throws. */
  async remember(snapshot: PiPgmPipelineSnapshot, png: Buffer): Promise<void> {
    const item = snapshot.activeItemId ? this.options.getItem(snapshot.activeItemId) : undefined;
    if (!item || !STILL_KINDS.has(item.kind)) return;
    try {
      await this.save(item, snapshot.orientation, snapshot.currentStep, png);
    } catch {
      // a failed save only means the next time renders again
    }
  }

  private async save(item: PiPgmItem, orientation: PiPgmOrientation, step: number, png: Buffer): Promise<void> {
    await this.store.put(this.key(item, orientation, step, false), png, { contentType: "image/png" });
    const jpg = await this.thumbnailer(png);
    await this.store.put(this.key(item, orientation, step, true), jpg, { contentType: "image/jpeg" });
  }

  /** Which steps of an item have a prepared picture (checked against the store). */
  async steps(itemId: string, orientation: PiPgmOrientation): Promise<StepInfo[] | null> {
    const item = this.options.getItem(itemId);
    if (!item) return null;
    const keys = new Set(await this.store.list(`${this.prefix}/${item.id}/${itemVersion(item, orientation)}/${orientation}/`));
    return item.steps.map((s, step) => ({
      step,
      label: s.label,
      prepared: keys.has(this.key(item, orientation, step, false)) && keys.has(this.key(item, orientation, step, true))
    }));
  }

  status(itemId: string, orientation: PiPgmOrientation): PrepareState {
    return this.jobs.get(`${itemId}|${orientation}`) ?? { state: "idle", done: 0, total: 0, error: null };
  }

  /**
   * Renders and stores every step that has no picture yet, one at a time, in the background.
   * Returns the state straight away; poll status() for progress. Older versions of the item are removed at the end.
   */
  prepare(itemId: string, orientation: PiPgmOrientation): PrepareState | "ITEM_NOT_FOUND" | "NOT_STILL_ITEM" {
    const item = this.options.getItem(itemId);
    if (!item) return "ITEM_NOT_FOUND";
    if (!STILL_KINDS.has(item.kind)) return "NOT_STILL_ITEM";
    const id = `${itemId}|${orientation}`;
    const running = this.jobs.get(id);
    if (running?.state === "running") return running;
    const job: PrepareState = { state: "running", done: 0, total: item.steps.length, error: null };
    this.jobs.set(id, job);
    void this.run(item, orientation, job);
    return job;
  }

  private async run(item: PiPgmItem, orientation: PiPgmOrientation, job: PrepareState): Promise<void> {
    try {
      const have = await this.steps(item.id, orientation);
      for (let step = 0; step < item.steps.length; step += 1) {
        if (!have?.[step]?.prepared) {
          const snapshot = this.options.snapshotForStep(item.id, step, orientation);
          if (!snapshot) throw new Error(`step ${step} of ${item.id} is gone`);
          const { width, height } = snapshot.resolution;
          const png = await this.options.renderFrame({
            html: renderPiPgmStageHtml(snapshot, { transparent: false, silent: true }),
            width,
            height,
            transparent: false
          });
          await this.save(item, orientation, step, png);
        }
        job.done = step + 1;
      }
      await this.removeOldVersions(item, orientation);
      job.state = "done";
    } catch (error) {
      job.state = "failed";
      job.error = error instanceof Error ? error.message : String(error);
    }
  }

  private async removeOldVersions(item: PiPgmItem, orientation: PiPgmOrientation): Promise<void> {
    try {
      const keep = `${this.prefix}/${item.id}/${itemVersion(item, orientation)}/`;
      for (const key of await this.store.list(`${this.prefix}/${item.id}/`)) {
        if (!key.startsWith(keep) && key.includes(`/${orientation}/`)) await this.store.delete(key);
      }
    } catch {
      // old pictures staying is harmless
    }
  }

  /** Removes everything prepared for an item (when the item is deleted). */
  async remove(itemId: string): Promise<void> {
    try {
      for (const key of await this.store.list(`${this.prefix}/${itemId}/`)) await this.store.delete(key);
    } catch {
      // the store may be down; the pictures are harmless leftovers
    }
  }
}
