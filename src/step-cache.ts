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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlobStore } from "./library-store.js";
import type { PipgmFrameRenderer } from "./frame.js";
import { getResolutionForOrientation, type PiPgmItem, type PiPgmOrientation, type PiPgmPipelineSnapshot } from "./pipgm-model.js";
import { renderPiPgmStageHtml } from "./stage-html.js";

/** Item kinds whose steps are still pictures. Video, audio and YouTube are not. */
export const STILL_KINDS: ReadonlySet<string> = new Set(["pptx", "hymn", "image", "canva"]);
export const THUMBNAIL_WIDTH = 320;

export type StepVariant =
  | "landscape"
  | "portrait"
  | "9:16"
  | "10:16"
  | "chroma-left"
  | "chroma-right"
  | "rgba-left"
  | "rgba-right";

export type CanonicalStepVariant = Exclude<StepVariant, "9:16">;

export const ALL_CANONICAL_VARIANTS: readonly CanonicalStepVariant[] = [
  "portrait",
  "10:16",
  "landscape",
  "chroma-left",
  "chroma-right",
  "rgba-left",
  "rgba-right"
];

export interface VariantRenderOptions {
  variant?: StepVariant | undefined;
  width?: number | undefined;
  height?: number | undefined;
  side?: "left" | "right" | undefined;
  keyMode?: "chroma" | "luma" | "rgba" | undefined;
  keyColor?: string | undefined;
  slideAspect?: "9:16" | "10:16" | undefined;
  slideScale?: number | undefined;
  offsetX?: number | undefined;
  offsetY?: number | undefined;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPngBuffer(bytes: Buffer): boolean {
  return bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

export function isSupportedImageBuffer(bytes: Buffer): boolean {
  if (isPngBuffer(bytes)) return true;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true; // JPEG
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return true; // WebP
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a")) return true; // GIF
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return true; // BMP
  return false;
}

export function makeEven(value: number): number {
  return Math.round(value / 2) * 2;
}

export function normalizeVariant(variant: StepVariant): CanonicalStepVariant {
  return variant === "9:16" ? "portrait" : variant;
}

export function variantResolution(variant: StepVariant): { width: number; height: number } {
  const norm = normalizeVariant(variant);
  if (norm === "portrait") return { width: 1080, height: 1920 };
  if (norm === "10:16") return { width: 1200, height: 1920 };
  return { width: 1920, height: 1080 };
}

export function resolveStandardVariant(variantOrOptions: StepVariant | VariantRenderOptions): CanonicalStepVariant | null {
  if (typeof variantOrOptions === "string") return normalizeVariant(variantOrOptions);
  const opts = variantOrOptions;
  if (opts.variant) {
    const norm = normalizeVariant(opts.variant);
    const res = variantResolution(norm);
    const hasCustomSize = (opts.width !== undefined && opts.width !== res.width) || (opts.height !== undefined && opts.height !== res.height);
    const expectedSide = norm.endsWith("-right") ? "right" : norm.endsWith("-left") ? "left" : undefined;
    const expectedOffsetX = expectedSide === "left" ? -1 : expectedSide === "right" ? 1 : undefined;
    const expectedKeyMode = norm.startsWith("chroma-") ? "chroma" : norm.startsWith("rgba-") ? "rgba" : undefined;
    const hasCustomPlacement =
      (opts.slideScale !== undefined && opts.slideScale !== 1) ||
      (opts.offsetY !== undefined && opts.offsetY !== 0) ||
      (opts.offsetX !== undefined && (expectedOffsetX === undefined || opts.offsetX !== expectedOffsetX)) ||
      (opts.side !== undefined && (expectedSide === undefined || opts.side !== expectedSide)) ||
      (opts.keyMode !== undefined && (expectedKeyMode === undefined || opts.keyMode !== expectedKeyMode)) ||
      (opts.keyColor !== undefined && opts.keyColor.toLowerCase() !== "#00ff00") ||
      (opts.slideAspect !== undefined && opts.slideAspect !== "9:16");
    if (!hasCustomSize && !hasCustomPlacement) return norm;
    return null;
  }

  const width = opts.width ?? 1920;
  const height = opts.height ?? 1080;
  const slideScale = opts.slideScale ?? 1;
  const offsetY = opts.offsetY ?? 0;
  const keyColor = (opts.keyColor ?? "#00ff00").toLowerCase();
  const side = opts.side ?? (opts.offsetX !== undefined && opts.offsetX >= 0 ? "right" : "left");
  const offsetX = opts.offsetX ?? (side === "left" ? -1 : 1);

  if (opts.keyMode) {
    if (width === 1920 && height === 1080 && slideScale === 1 && offsetY === 0) {
      if (opts.keyMode === "rgba" && (offsetX === -1 || offsetX === 1)) {
        return offsetX === -1 ? "rgba-left" : "rgba-right";
      }
      if (opts.keyMode === "chroma" && keyColor === "#00ff00" && (offsetX === -1 || offsetX === 1)) {
        return offsetX === -1 ? "chroma-left" : "chroma-right";
      }
    }
    return null;
  }

  if (
    !opts.side &&
    opts.offsetX === undefined &&
    opts.offsetY === undefined &&
    (opts.slideScale === undefined || opts.slideScale === 1)
  ) {
    if (width === 1080 && height === 1920) return "portrait";
    if (width === 1200 && height === 1920) return "10:16";
    if (width === 1920 && height === 1080) return "landscape";
  }
  return null;
}

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

export function itemVersion(item: PiPgmItem, orientationOrVariant: PiPgmOrientation | StepVariant): string {
  const norm = normalizeVariant(orientationOrVariant);
  const { width, height } = norm === "landscape" || norm === "portrait"
    ? getResolutionForOrientation(norm)
    : variantResolution(norm);
  const parts: unknown[] =
    norm === "landscape" || norm === "portrait"
      ? [item.kind, item.title, item.steps, width, height]
      : [item.kind, item.title, item.steps, width, height, norm];
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 16);
}

function runFfmpeg(ffmpeg: string, args: string[], stdin?: Buffer, timeoutMs = 30_000): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["pipe", "pipe", "pipe"] });
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
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited with code ${code}: ${Buffer.concat(err).toString("utf8").slice(0, 300)}`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
  });
}

export function buildKeyOverlayFilter(options: VariantRenderOptions, inputLabel = "0:v", outLabel = "out"): string {
  const width = options.width ?? 1920;
  const height = options.height ?? 1080;
  const slideScale = Math.max(0.6, Math.min(1, options.slideScale ?? 1));
  const side = options.side ?? (options.offsetX !== undefined && options.offsetX >= 0 ? "right" : "left");
  const offsetX = Math.max(-1, Math.min(1, options.offsetX ?? (side === "left" ? -1 : 1)));
  const offsetY = Math.max(-1, Math.min(1, options.offsetY ?? 0));
  const keyMode = options.keyMode ?? "chroma";
  const keyColor = options.keyColor ?? "#00ff00";

  let boxH = Math.min(height, makeEven(height * slideScale));
  let boxW = Math.min(width, makeEven(width * slideScale));
  if (options.slideAspect) {
    const ratio = options.slideAspect === "10:16" ? 10 / 16 : 9 / 16;
    boxW = Math.min(width, makeEven(boxH * ratio));
  }

  const bgColour = keyMode === "rgba" ? "black@0" : keyMode === "luma" ? "0x000000" : `0x${keyColor.slice(1)}`;
  const bgTag = `bg_${outLabel}`;
  const slideTag = `slide_${outLabel}`;
  return [
    `color=c=${bgColour}:s=${width}x${height}:r=1,format=rgba[${bgTag}]`,
    `[${inputLabel}]scale=${boxW}:${boxH}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,format=rgba[${slideTag}]`,
    `[${bgTag}][${slideTag}]overlay=x='round((W-w)/2+(${offsetX})*(W-w)/2)':y='round((H-h)/2+(${offsetY})*(H-h)/2)':format=auto,format=rgba[${outLabel}]`
  ].join(";");
}

/**
 * Single-decode ffmpeg pass producing all target variants + 320px JPEG thumbnail.
 */
export async function ffmpegRenderAllVariants(
  inputBytes: Buffer,
  ffmpeg = process.env.PIPGM_FFMPEG?.trim() || "ffmpeg",
  timeoutMs = 30_000
): Promise<{ variants: Record<CanonicalStepVariant, Buffer>; thumbnail: Buffer }> {
  const dir = await mkdtemp(join(tmpdir(), "pipgm-variants-"));
  try {
    const inPath = join(dir, "input");
    await writeFile(inPath, inputBytes);
    const fc = [
      "[0:v]split=8[v1][v2][v3][v4][v5][v6][v7][vt]",
      "[v1]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,format=rgba[portrait]",
      "[v2]scale=1200:1920:force_original_aspect_ratio=decrease,pad=1200:1920:(ow-iw)/2:(oh-ih)/2:black,format=rgba[p1016]",
      "[v3]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,format=rgba[landscape]",
      buildKeyOverlayFilter({ keyMode: "chroma", keyColor: "#00ff00", side: "left", offsetX: -1 }, "v4", "cl"),
      buildKeyOverlayFilter({ keyMode: "chroma", keyColor: "#00ff00", side: "right", offsetX: 1 }, "v5", "cr"),
      buildKeyOverlayFilter({ keyMode: "rgba", side: "left", offsetX: -1 }, "v6", "rl"),
      buildKeyOverlayFilter({ keyMode: "rgba", side: "right", offsetX: 1 }, "v7", "rr"),
      `[vt]scale=${THUMBNAIL_WIDTH}:-2[thumb]`
    ].join(";");

    const outPaths = {
      portrait: join(dir, "portrait.png"),
      "10:16": join(dir, "10-16.png"),
      landscape: join(dir, "landscape.png"),
      "chroma-left": join(dir, "chroma-left.png"),
      "chroma-right": join(dir, "chroma-right.png"),
      "rgba-left": join(dir, "rgba-left.png"),
      "rgba-right": join(dir, "rgba-right.png"),
      thumb: join(dir, "thumb.jpg")
    };

    await runFfmpeg(
      ffmpeg,
      [
        "-y", "-loglevel", "error", "-nostdin",
        "-i", inPath,
        "-filter_complex", fc,
        "-map", "[portrait]", "-frames:v", "1", outPaths.portrait,
        "-map", "[p1016]", "-frames:v", "1", outPaths["10:16"],
        "-map", "[landscape]", "-frames:v", "1", outPaths.landscape,
        "-map", "[cl]", "-frames:v", "1", outPaths["chroma-left"],
        "-map", "[cr]", "-frames:v", "1", outPaths["chroma-right"],
        "-map", "[rl]", "-frames:v", "1", outPaths["rgba-left"],
        "-map", "[rr]", "-frames:v", "1", outPaths["rgba-right"],
        "-map", "[thumb]", "-frames:v", "1", "-q:v", "5", outPaths.thumb
      ],
      undefined,
      timeoutMs
    );

    const [portrait, p1016, landscape, chromaLeft, chromaRight, rgbaLeft, rgbaRight, thumbnail] = await Promise.all([
      readFile(outPaths.portrait),
      readFile(outPaths["10:16"]),
      readFile(outPaths.landscape),
      readFile(outPaths["chroma-left"]),
      readFile(outPaths["chroma-right"]),
      readFile(outPaths["rgba-left"]),
      readFile(outPaths["rgba-right"]),
      readFile(outPaths.thumb)
    ]);

    return {
      variants: {
        portrait,
        "10:16": p1016,
        landscape,
        "chroma-left": chromaLeft,
        "chroma-right": chromaRight,
        "rgba-left": rgbaLeft,
        "rgba-right": rgbaRight
      },
      thumbnail
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function ffmpegRenderCustomVariant(
  inputBytes: Buffer,
  options: VariantRenderOptions,
  ffmpeg = process.env.PIPGM_FFMPEG?.trim() || "ffmpeg",
  timeoutMs = 30_000
): Promise<Buffer> {
  const std = resolveStandardVariant(options);
  let fc: string;
  if (std === "portrait") {
    fc = "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,format=rgba[out]";
  } else if (std === "10:16") {
    fc = "[0:v]scale=1200:1920:force_original_aspect_ratio=decrease,pad=1200:1920:(ow-iw)/2:(oh-ih)/2:black,format=rgba[out]";
  } else if (std === "landscape") {
    fc = "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,format=rgba[out]";
  } else {
    const resolvedOpts: VariantRenderOptions = std === "chroma-left"
      ? { ...options, keyMode: "chroma", keyColor: "#00ff00", side: "left", offsetX: -1 }
      : std === "chroma-right"
        ? { ...options, keyMode: "chroma", keyColor: "#00ff00", side: "right", offsetX: 1 }
        : std === "rgba-left"
          ? { ...options, keyMode: "rgba", side: "left", offsetX: -1 }
          : std === "rgba-right"
            ? { ...options, keyMode: "rgba", side: "right", offsetX: 1 }
            : options;
    fc = buildKeyOverlayFilter(resolvedOpts, "0:v", "out");
  }

  return await runFfmpeg(
    ffmpeg,
    ["-loglevel", "error", "-i", "pipe:0", "-filter_complex", fc, "-map", "[out]", "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"],
    inputBytes,
    timeoutMs
  );
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
  /** Reads raw uploaded/exported asset bytes for static image and Canva slides (bypasses Chromium). */
  getAssetBytes?: ((assetId: string) => Promise<Buffer | null>) | undefined;
  ffmpeg?: string | undefined;
  thumbnailer?: Thumbnailer | undefined;
  prefix?: string | undefined;
}

export class StepImages {
  private readonly store: BlobStore;
  private readonly prefix: string;
  private readonly ffmpeg: string;
  private readonly thumbnailer: Thumbnailer;
  private readonly jobs = new Map<string, PrepareState>();

  constructor(private readonly options: StepImagesOptions) {
    this.store = options.store;
    this.prefix = options.prefix ?? "piprogram/steps";
    this.ffmpeg = options.ffmpeg ?? (process.env.PIPGM_FFMPEG?.trim() || "ffmpeg");
    this.thumbnailer = options.thumbnailer ?? ffmpegThumbnailer(this.ffmpeg);
  }

  private key(item: PiPgmItem, variant: StepVariant, step: number, thumb: boolean): string {
    const norm = normalizeVariant(variant);
    return `${this.prefix}/${item.id}/${itemVersion(item, norm)}/${norm}/${step}${thumb ? ".thumb.jpg" : ".png"}`;
  }

  /** The prepared PNG of a step, or null. A store problem is a miss (the caller renders instead). */
  async image(itemId: string, step: number, orientation: PiPgmOrientation): Promise<Buffer | null> {
    return this.read(itemId, step, orientation, false);
  }

  async thumbnail(itemId: string, step: number, orientation: PiPgmOrientation): Promise<Buffer | null> {
    return this.read(itemId, step, orientation, true);
  }

  /** The prepared PNG of a specific variant (or matching standard options), or null on miss. */
  async variantImage(itemId: string, step: number, variantOrOptions: StepVariant | VariantRenderOptions): Promise<Buffer | null> {
    const std = resolveStandardVariant(variantOrOptions);
    if (!std) return null;
    return this.read(itemId, step, std, false);
  }

  private async read(itemId: string, step: number, variant: StepVariant, thumb: boolean): Promise<Buffer | null> {
    const item = this.options.getItem(itemId);
    if (!item || !STILL_KINDS.has(item.kind) || !item.steps[step]) return null;
    try {
      return await this.store.get(this.key(item, variant, step, thumb));
    } catch {
      return null;
    }
  }

  /** The picture of the step on air in a snapshot, if it was prepared. */
  async lookup(snapshot: PiPgmPipelineSnapshot): Promise<Buffer | null> {
    if (!snapshot.activeItemId) return null;
    return this.image(snapshot.activeItemId, snapshot.currentStep, snapshot.orientation);
  }

  /** Looks up a pre-rendered variant for the active step in a snapshot. */
  async lookupVariant(snapshot: PiPgmPipelineSnapshot, variantOrOptions: StepVariant | VariantRenderOptions): Promise<Buffer | null> {
    if (!snapshot.activeItemId) return null;
    return this.variantImage(snapshot.activeItemId, snapshot.currentStep, variantOrOptions);
  }

  /**
   * Renders a custom placement/key variant via ffmpeg using the item's raw asset or cached base PNG,
   * avoiding headless Chromium whenever possible. Returns null if no base image is available.
   */
  async renderCustomVariant(itemId: string, step: number, options: VariantRenderOptions): Promise<Buffer | null> {
    const item = this.options.getItem(itemId);
    if (!item || !STILL_KINDS.has(item.kind) || !item.steps[step]) return null;
    let baseBytes = await this.readStaticAssetBytes(item, step);
    if (!baseBytes || !isSupportedImageBuffer(baseBytes)) {
      baseBytes = (await this.image(itemId, step, "portrait")) ?? (await this.image(itemId, step, "landscape"));
    }
    if (!baseBytes || !isSupportedImageBuffer(baseBytes)) return null;
    return await ffmpegRenderCustomVariant(baseBytes, options, this.ffmpeg);
  }

  private async readStaticAssetBytes(item: PiPgmItem, step: number): Promise<Buffer | null> {
    if (!this.options.getAssetBytes) return null;
    let assetId: string | undefined;
    if (item.kind === "image" && !item.image?.caption?.trim()) {
      assetId = item.image?.assetId;
    } else if (item.kind === "canva" && item.canva?.mode === "exported_slides") {
      assetId = item.canva.pages[step]?.assetId;
    }
    if (!assetId) return null;
    try {
      return await this.options.getAssetBytes(assetId);
    } catch {
      return null;
    }
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
    const meta = item.useAt?.length ? { useAt: item.useAt } : {};
    await this.store.put(this.key(item, orientation, step, false), png, { contentType: "image/png", ...meta });
    const jpg = await this.thumbnailer(png);
    await this.store.put(this.key(item, orientation, step, true), jpg, { contentType: "image/jpeg", ...meta });
  }

  private async saveAllVariants(item: PiPgmItem, step: number, rendered: { variants: Record<CanonicalStepVariant, Buffer>; thumbnail: Buffer }): Promise<void> {
    const meta = item.useAt?.length ? { useAt: item.useAt } : {};
    await Promise.all([
      ...ALL_CANONICAL_VARIANTS.map((variant) =>
        this.store.put(this.key(item, variant, step, false), rendered.variants[variant], { contentType: "image/png", ...meta })
      ),
      this.store.put(this.key(item, "portrait", step, true), rendered.thumbnail, { contentType: "image/jpeg", ...meta }),
      this.store.put(this.key(item, "landscape", step, true), rendered.thumbnail, { contentType: "image/jpeg", ...meta })
    ]);
  }

  /**
   * Gives the prepared pictures of an item (all orientations and versions) a new date in the
   * store without sending them again. Never throws: a store problem only means that the
   * pictures keep their old date, and new ones carry the item's date.
   */
  async setUseAt(itemId: string, useAt: string[]): Promise<number> {
    let changed = 0;
    try {
      for (const key of await this.store.list(`${this.prefix}/${itemId}/`)) {
        if (await this.store.setUseAt(key, useAt)) changed += 1;
      }
    } catch {
      // see above
    }
    return changed;
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
      const existingKeys = new Set(await this.store.list(`${this.prefix}/${item.id}/`));
      const derivedVariants: CanonicalStepVariant[] = ["chroma-left", "chroma-right", "rgba-left", "rgba-right"];
      if (orientation === "portrait") derivedVariants.push("10:16");
      for (let step = 0; step < item.steps.length; step += 1) {
        const alreadyPrepared = have?.[step]?.prepared ?? false;
        let needsPrepare = !alreadyPrepared;
        if (alreadyPrepared) {
          const missingVariant = derivedVariants.some((v) => !existingKeys.has(this.key(item, v, step, false)));
          if (missingVariant) {
            const existingBase = await this.image(item.id, step, orientation);
            if (existingBase && isPngBuffer(existingBase)) needsPrepare = true;
          }
        }
        if (needsPrepare) {
          const assetBytes = await this.readStaticAssetBytes(item, step);
          if (assetBytes && isSupportedImageBuffer(assetBytes)) {
            const rendered = await ffmpegRenderAllVariants(assetBytes, this.ffmpeg);
            await this.saveAllVariants(item, step, rendered);
          } else {
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
            if (isPngBuffer(png)) {
              const meta = item.useAt?.length ? { useAt: item.useAt } : {};
              const keySnapshot = this.options.snapshotForStep(item.id, step, "portrait") ?? snapshot;
              const keyPng = await this.options.renderFrame({
                html: renderPiPgmStageHtml(keySnapshot, { transparent: true, silent: true }),
                width: keySnapshot.resolution.width,
                height: keySnapshot.resolution.height,
                transparent: true
              });
              const baseForVariants = isPngBuffer(keyPng) ? keyPng : png;
              const derived = await ffmpegRenderAllVariants(baseForVariants, this.ffmpeg);
              await Promise.all(
                derivedVariants.map((variant) =>
                  this.store.put(this.key(item, variant, step, false), derived.variants[variant], { contentType: "image/png", ...meta })
                )
              );
            }
          }
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
      const keepPrefixes = new Set(ALL_CANONICAL_VARIANTS.map((v) => `${this.prefix}/${item.id}/${itemVersion(item, v)}/${v}/`));
      for (const key of await this.store.list(`${this.prefix}/${item.id}/`)) {
        const isCurrent = [...keepPrefixes].some((p) => key.startsWith(p));
        if (!isCurrent && (key.includes(`/${orientation}/`) || ALL_CANONICAL_VARIANTS.some((v) => v !== "portrait" && v !== "landscape" && key.includes(`/${v}/`)))) {
          await this.store.delete(key);
        }
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
