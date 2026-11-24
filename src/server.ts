/**
 * HTTP API for PiPGM (piprogram). The routes and their error shapes match the
 * `/api/v1/pipgm/*` routes that pimatrix served before the split, so existing
 * clients keep working. Canva routes are not here yet (they are the 1.1 step).
 *
 * Auth: when an API key is configured, every non-GET request under /api/v1/
 * needs `Authorization: Bearer <key>` or `x-api-key`. Reads stay open, as in pimatrix.
 */

import { UseAtError } from "./use-at.js";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { LIBRARY_ZONE, MAX_AUDIO_ARM_SECONDS, PiPgmService, type PiPgmServiceOptions } from "./pipgm-service.js";
import type {
  PiPgmAsset,
  PiPgmControlAction,
  PiPgmOrientation,
  PiPgmPipelineId,
  PptxAnimationEffect
} from "./pipgm-model.js";
import { renderPiPgmStageHtml } from "./stage-html.js";
import { createChromiumFrameRenderer, FrameRendererUnavailableError, type PipgmFrameRenderer } from "./frame.js";
import { CanvaPackages, imageTypeOf, numberPages } from "./canva-package.js";
import { StepImages, ffmpegRenderCustomVariant, ffmpegThumbnailer, isSupportedImageBuffer, variantResolution, type StepVariant, type Thumbnailer, type VariantRenderOptions } from "./step-cache.js";
import { MemoryBlobStore, type BlobStore } from "./library-store.js";
import { ActiveFolderStore } from "./active-folder.js";
import { HYMNAL_PREFIX, DEFAULT_HYMNALS, type Hymnal } from "./hymnals.js";
import { queryLibrary, normalizeLibraryType, libraryTypeOf, STANDARD_LIBRARY_TYPES, type LibraryQuery } from "./library-query.js";
import { PlaylistStore, isPlaylistId, savedItemOf, validatePlaylist } from "./playlist-store.js";
import type { EncoderSelector } from "./encoder.js";
import { PipgmFeeders, type FeedInput, type FeederEncoder, type PngToRaw, type SpawnFeeder } from "./feeder.js";
import type { AudioToPcm } from "./feed-audio.js";
import { AUDIO_LEVEL_NAMES, isAudioLevelName } from "./audio-levels.js";
import { ALSA_DEVICE, LocalAudio, SoundOutputState, SOUND_OUTPUTS, isSoundOutput, type SoundOutput, type SpawnLocalPlayer } from "./local-audio.js";
import { PublishController } from "./publish-controller.js";
import { RuntimeSettingsFile } from "./runtime-settings.js";
import { ffmpegAudioToPcm } from "./feed-audio.js";

export interface PipgmServerOptions extends PiPgmServiceOptions {
  /** The known hymnals (prefix and name); default VK and LV. A hymn number may carry any prefix, known or not. */
  hymnals?: Hymnal[] | undefined;
  /** How often an unloaded library or unsaved items are retried against the store (default 60 s). */
  libraryRetryMs?: number | undefined;
  /**
   * Where prepared step pictures and thumbnails are kept (pistorage in production). Without it they are
   * kept in memory and lost on restart.
   */
  stepStore?: BlobStore | undefined;
  /** Where saved playlists are kept (pistorage in production; memory without it). */
  playlistStore?: BlobStore | undefined;
  /** This server's own address as the screenshot browser reaches it (default http://127.0.0.1:$PIPGM_PORT). */
  selfUrl?: string | undefined;
  /** How often a package task looks at the picture preparation (default 100 ms). For tests. */
  packagePollMs?: number | undefined;
  /** Makes a thumbnail from a PNG; default ffmpeg. For tests. */
  thumbnailer?: Thumbnailer | undefined;
  /** Service instance; a new PiPgmService is created from the options when omitted. */
  service?: PiPgmService;
  /** API key for mutating requests. Undefined = open (development). */
  apiKey?: string | undefined;
  /** Logger passed to Fastify; false disables logging. */
  logger?: boolean;
  /** Renders the frame route. Defaults to headless Chromium (PIPGM_CHROMIUM). */
  frameRenderer?: PipgmFrameRenderer;
  /**
   * How the three feeds (PiPGM1-3) are published to MediaMTX from this process. Publishing itself is switched on and
   * off at runtime (PUT /api/v1/pipgm/publish, kept in the cache directory); `rtspBase` and `audio` here only seed the
   * first start, when nothing has been stored. Without `rtspBase` publishing starts off. The rest are tools:
   * `encoder` may be a function that makes the selector when publishing is first switched on (the probe runs then).
   */
  publish?: { rtspBase?: string; ffmpeg?: string; encoder?: FeederEncoder | EncoderSelector | (() => Promise<EncoderSelector>); idleStopSeconds?: number; fps?: number; spawn?: SpawnFeeder; feedInput?: FeedInput; convert?: PngToRaw; audio?: boolean; audioToPcm?: AudioToPcm };
  /** Local audio (TTS straight to an HDMI sound card): seeds the first start; changed at runtime with PUT /api/v1/pipgm/local-audio. */
  localAudio?: { devices?: Partial<Record<SoundOutput, string>>; aplay?: string; spawn?: SpawnLocalPlayer; toPcm?: AudioToPcm; soundOutputMaxAgeSeconds?: number };
}

const FRAME_MIN_SIDE = 16;
const FRAME_MAX_SIDE = 3840;

type FrameQuery = {
  width?: string;
  height?: string;
  alpha?: string;
  variant?: string;
  side?: string;
  keyMode?: string;
  keyColor?: string;
  slideAspect?: string;
  slideScale?: string;
  offsetX?: string;
  offsetY?: string;
};

const VALID_VARIANTS = new Set<StepVariant>([
  "landscape",
  "portrait",
  "9:16",
  "10:16",
  "chroma-left",
  "chroma-right",
  "rgba-left",
  "rgba-right"
]);

/** Frame size, alpha, and optional composite/variant parameters from the query string. */
function parseFrameQuery(
  query: FrameQuery,
  resolution: { width: number; height: number }
): { ok: true; width: number; height: number; alpha: boolean; variantOptions: VariantRenderOptions | null } | { ok: false; message: string } {
  const variant = query.variant as StepVariant | undefined;
  if (variant !== undefined && !VALID_VARIANTS.has(variant)) {
    return { ok: false, message: "variant must be one of landscape, portrait, 9:16, 10:16, chroma-left, chroma-right, rgba-left, rgba-right" };
  }
  const hasCompositeParam =
    variant !== undefined ||
    query.side !== undefined ||
    query.keyMode !== undefined ||
    query.keyColor !== undefined ||
    query.slideAspect !== undefined ||
    query.slideScale !== undefined ||
    query.offsetX !== undefined ||
    query.offsetY !== undefined;

  const defaultRes = variant
    ? variantResolution(variant)
    : hasCompositeParam
      ? { width: 1920, height: 1080 }
      : resolution;

  const sideVal = (value: string | undefined, fallback: number, name: string) => {
    if (value === undefined) return { ok: true as const, value: fallback };
    const parsed = /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isInteger(parsed) || parsed < FRAME_MIN_SIDE || parsed > FRAME_MAX_SIDE) {
      return { ok: false as const, message: `${name} must be a whole number from ${FRAME_MIN_SIDE} to ${FRAME_MAX_SIDE}` };
    }
    return { ok: true as const, value: parsed };
  };
  const width = sideVal(query.width, defaultRes.width, "width");
  if (!width.ok) return { ok: false, message: width.message };
  const height = sideVal(query.height, defaultRes.height, "height");
  if (!height.ok) return { ok: false, message: height.message };
  if (query.alpha !== undefined && !["1", "0", "true", "false"].includes(query.alpha)) {
    return { ok: false, message: "alpha must be 1, 0, true or false" };
  }

  let side: "left" | "right" | undefined;
  if (query.side !== undefined) {
    if (query.side !== "left" && query.side !== "right") return { ok: false, message: "side must be left or right" };
    side = query.side;
  }
  let keyMode: "chroma" | "luma" | "rgba" | undefined;
  if (query.keyMode !== undefined) {
    if (query.keyMode !== "chroma" && query.keyMode !== "luma" && query.keyMode !== "rgba") {
      return { ok: false, message: "keyMode must be chroma, luma or rgba" };
    }
    keyMode = query.keyMode;
  }
  let keyColor: string | undefined;
  if (query.keyColor !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(query.keyColor)) return { ok: false, message: "keyColor must be #rrggbb" };
    keyColor = query.keyColor.toLowerCase();
  }
  let slideAspect: "9:16" | "10:16" | undefined;
  if (query.slideAspect !== undefined) {
    if (query.slideAspect !== "9:16" && query.slideAspect !== "10:16") return { ok: false, message: "slideAspect must be 9:16 or 10:16" };
    slideAspect = query.slideAspect;
  }
  const parseNum = (raw: string | undefined, min: number, max: number, name: string) => {
    if (raw === undefined) return { ok: true as const, value: undefined };
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) {
      return { ok: false as const, message: `${name} must be a number from ${min} to ${max}` };
    }
    return { ok: true as const, value: n };
  };
  const slideScale = parseNum(query.slideScale, 0.6, 1, "slideScale");
  if (!slideScale.ok) return { ok: false, message: slideScale.message };
  const offsetX = parseNum(query.offsetX, -1, 1, "offsetX");
  if (!offsetX.ok) return { ok: false, message: offsetX.message };
  const offsetY = parseNum(query.offsetY, -1, 1, "offsetY");
  if (!offsetY.ok) return { ok: false, message: offsetY.message };

  const alpha = query.alpha === "1" || query.alpha === "true" || keyMode === "rgba" || variant === "rgba-left" || variant === "rgba-right";

  const variantOptions: VariantRenderOptions | null = hasCompositeParam
    ? {
        ...(variant !== undefined ? { variant } : {}),
        width: width.value,
        height: height.value,
        ...(side !== undefined ? { side } : {}),
        ...(keyMode !== undefined ? { keyMode } : {}),
        ...(keyColor !== undefined ? { keyColor } : {}),
        ...(slideAspect !== undefined ? { slideAspect } : {}),
        ...(slideScale.value !== undefined ? { slideScale: slideScale.value } : {}),
        ...(offsetX.value !== undefined ? { offsetX: offsetX.value } : {}),
        ...(offsetY.value !== undefined ? { offsetY: offsetY.value } : {})
      }
    : null;

  return {
    ok: true,
    width: width.value,
    height: height.value,
    alpha,
    variantOptions
  };
}

const VALID_CONTROL_ACTIONS = new Set<PiPgmControlAction>([
  "next",
  "prev",
  "gotoStep",
  "gotoItem",
  "play",
  "pause",
  "stop",
  "restart"
]);

function notFound(reply: FastifyReply, pipelineId: string) {
  return reply.code(404).send({
    error: { code: "PIPELINE_NOT_FOUND", message: `Unknown PiPGM pipeline: ${pipelineId}` }
  });
}

function invalid(reply: FastifyReply, code: string, message: string) {
  return reply.code(422).send({ error: { code, message } });
}

function presentedKey(request: FastifyRequest): string | undefined {
  const auth = request.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const header = request.headers["x-api-key"];
  return typeof header === "string" ? header.trim() : undefined;
}

export function buildPipgmServer(options: PipgmServerOptions = {}): FastifyInstance {
  // The browser loads the stage page from a temporary file, so relative asset URLs (/api/v1/pipgm/assets/...)
  // need a base that points back at this server.
  const selfUrl = (options.selfUrl ?? `http://127.0.0.1:${process.env.PIPGM_PORT?.trim() || "3200"}`).replace(/\/+$/, "");
  const baseFrameRenderer = options.frameRenderer ?? createChromiumFrameRenderer();
  const renderFrame: PipgmFrameRenderer = (request) =>
    baseFrameRenderer({ ...request, html: request.html.replace(/<head>/i, `<head>\n  <base href="${selfUrl}/">`) });
  const service = options.service ?? new PiPgmService({ frameRenderer: renderFrame, ...options });
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 50 * 1024 * 1024 // direct .pptx, video and image uploads (base64 JSON)
  });

  app.addHook("onRequest", async (request, reply) => {
    const url = request.url.split("?")[0] ?? "";
    if (!options.apiKey) return;
    if (!url.startsWith("/api/v1/") || request.method === "GET") return;
    if (presentedKey(request) === options.apiKey) return;
    return reply.code(401).send({
      statusCode: 401,
      error: "Unauthorized",
      message: "Valid API key required"
    });
  });

  const configuredHymnals: Hymnal[] = options.hymnals?.length ? options.hymnals : DEFAULT_HYMNALS.map((h) => ({ ...h }));
  /** The configured hymnals plus any other prefix found in the library, named by the prefix. */
  const hymnalList = (found: string[] = []): Hymnal[] => [
    ...configuredHymnals,
    ...found.filter((p) => !configuredHymnals.some((h) => h.prefix === p)).map((prefix) => ({ prefix, name: prefix }))
  ];
  app.get("/api/v1/pipgm/hymnals", async () => ({ hymnals: configuredHymnals }));

  app.get("/health", async () => ({ status: "ok", service: "piprogram" }));

  const steps = new StepImages({
    store: options.stepStore ?? new MemoryBlobStore(),
    renderFrame,
    snapshotForStep: (itemId, step, orientation) => service.snapshotForStep(itemId, step, orientation),
    getItem: (itemId) => service.getLibraryItem(itemId),
    getAssetBytes: (assetId) => service.readAssetBytes(assetId),
    ffmpeg: options.publish?.ffmpeg,
    thumbnailer: options.thumbnailer ?? ffmpegThumbnailer(options.publish?.ffmpeg)
  });
  service.setStepImages(steps);

  const playlists = new PlaylistStore(options.playlistStore ?? new MemoryBlobStore());
  const active = new ActiveFolderStore(options.playlistStore ?? new MemoryBlobStore());
  const storageDown = (reply: FastifyReply, error: unknown) =>
    reply.code(503).send({
      error: { code: "STORAGE_UNAVAILABLE", message: `The playlist store is not reachable: ${error instanceof Error ? error.message : String(error)}` }
    });
  const playlistNotFound = (reply: FastifyReply, id: string) =>
    reply.code(404).send({ error: { code: "PLAYLIST_NOT_FOUND", message: `Unknown saved playlist: ${id}` } });
  /** A request names its loudness as `volume` (0-100) or `level` (whisper|normal|loud|shout), not both. */
  const resolveVolume = (
    volumeValue: unknown,
    levelValue: unknown
  ): { ok: true; volume: number | undefined } | { ok: false; code: string; message: string } => {
    if (volumeValue !== undefined && levelValue !== undefined) {
      return { ok: false, code: "VOLUME_AND_LEVEL", message: "give volume or level, not both" };
    }
    if (levelValue !== undefined) {
      if (!isAudioLevelName(levelValue)) {
        return { ok: false, code: "INVALID_LEVEL", message: `level must be one of ${AUDIO_LEVEL_NAMES.join(", ")}` };
      }
      return { ok: true, volume: service.audioLevels[levelValue] };
    }
    if (volumeValue === undefined) return { ok: true, volume: undefined };
    const volume = Number(volumeValue);
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
      return { ok: false, code: "INVALID_VOLUME", message: "volume must be between 0 and 100" };
    }
    return { ok: true, volume };
  };
  const invalidPlaylist = (reply: FastifyReply, errors: string[]) =>
    reply.code(422).send({ error: { code: "INVALID_PLAYLIST", message: errors.join("; "), errors } });

  const publishOptions = options.publish ?? {};
  const publisher = new PublishController({
    cacheDir: options.cacheDir,
    defaults: { rtspBase: publishOptions.rtspBase, audio: publishOptions.audio },
    onError: (message) => app.log.warn(message),
    create: async ({ rtspBase, audio }) => {
      const encoder = typeof publishOptions.encoder === "function" ? await publishOptions.encoder() : publishOptions.encoder;
      return new PipgmFeeders({
        service,
        renderFrame,
        rtspBase,
        ffmpeg: publishOptions.ffmpeg,
        encoder,
        idleStopSeconds: publishOptions.idleStopSeconds,
        onFallback: (message) => app.log.warn(message),
        fps: publishOptions.fps,
        feedInput: publishOptions.feedInput,
        convert: publishOptions.convert,
        ...(audio ? { audio: { load: (itemId: string) => service.readAudioItemBytes(itemId), toPcm: publishOptions.audioToPcm } } : {}),
        spawn: publishOptions.spawn,
        steps,
        onError: (pipelineId, message) => app.log.warn({ pipelineId, err: message }, "feed publisher")
      });
    }
  });
  app.addHook("onReady", async () => publisher.start());
  app.addHook("onClose", async () => publisher.stop());

  // Local audio: a spoken item straight to an HDMI sound card. Which output reaches the PA is reported by pigateway.
  const localSeed = options.localAudio ?? {};
  const localFile = new RuntimeSettingsFile<{ enabled: boolean; devices: Partial<Record<SoundOutput, string>> }>(options.cacheDir, "local-audio.json");
  const localStored = localFile.read();
  const localAudio = new LocalAudio({
    enabled: localStored?.enabled === true,
    devices: localStored?.devices ?? localSeed.devices ?? {},
    aplay: localSeed.aplay,
    spawn: localSeed.spawn,
    toPcm: localSeed.toPcm ?? ffmpegAudioToPcm(publishOptions.ffmpeg)
  });
  const soundOutput = new SoundOutputState((localSeed.soundOutputMaxAgeSeconds ?? 30) * 1000);
  app.addHook("onClose", async () => localAudio.stop());

  // The stored library is read when the server is ready; if the store is down, that and any unsaved
  // writes are retried on a timer until they go through.
  let libraryLoaded = !options.libraryStore;
  let libraryTimer: ReturnType<typeof setInterval> | null = null;
  const syncLibrary = async (): Promise<void> => {
    try {
      if (!libraryLoaded) {
        const count = await service.loadLibrary((key, reason) => app.log.warn({ key, reason }, "library entry skipped"));
        libraryLoaded = true;
        app.log.info({ count }, "library loaded from the store");
      }
      await service.flushLibrary();
    } catch (error) {
      app.log.warn({ err: error instanceof Error ? error.message : String(error) }, "library store unavailable");
    }
  };
  if (options.libraryStore) {
    app.addHook("onReady", async () => {
      await syncLibrary();
      libraryTimer = setInterval(() => void syncLibrary(), options.libraryRetryMs ?? 60_000);
      libraryTimer.unref();
    });
    app.addHook("onClose", async () => {
      if (libraryTimer) clearInterval(libraryTimer);
      libraryTimer = null;
    });
  }

  app.get("/api/v1/pipgm/library/storage", async () => ({ ...service.libraryStorageStatus(), loaded: libraryLoaded }));

  app.delete<{ Params: { itemId: string } }>("/api/v1/pipgm/items/:itemId", async (request, reply) => {
    try {
      const removed = await service.deleteLibraryItem(request.params.itemId);
      if (!removed) {
        return reply.code(404).send({ error: { code: "ITEM_NOT_FOUND", message: `Unknown library item: ${request.params.itemId}` } });
      }
    } catch (error) {
      return reply.code(503).send({
        error: { code: "STORE_UNAVAILABLE", message: `The library store could not delete the files: ${error instanceof Error ? error.message : String(error)}` }
      });
    }
    void steps.remove(request.params.itemId);
    return reply.code(204).send();
  });

  // ---- Canva export packages ----------------------------------------------------
  const packages = new CanvaPackages({ service, steps, pollMs: options.packagePollMs });
  app.addContentTypeParser(["application/zip", "application/x-zip-compressed", "application/octet-stream"], { parseAs: "buffer" }, (_request, body, done) =>
    done(null, body)
  );

  app.post<{ Body: Record<string, unknown> }>("/api/v1/pipgm/items/canva", async (request, reply) => {
    try {
      const item = await service.createOrPushCanvaItem((request.body ?? {}) as never, true);
      if (!item) return invalid(reply, "INVALID_CANVA_DESIGN", "designId or a Canva design URL is required");
      return reply.code(201).send(item);
    } catch (error) {
      if (error instanceof UseAtError) return invalid(reply, "INVALID_USE_AT", error.message);
      throw error;
    }
  });

  // When an item is meant to be used (days, hours, moments, ranges: see src/use-at.ts), so that
  // pistorage can have its files in the Pi cache beforehand. null clears it.
  app.put<{ Params: { itemId: string }; Body: { useAt?: unknown } }>("/api/v1/pipgm/items/:itemId/use-at", async (request, reply) => {
    const value = request.body?.useAt;
    if (value !== null && typeof value !== "string" && !(Array.isArray(value) && value.every((v) => typeof v === "string"))) {
      return invalid(reply, "INVALID_USE_AT", "useAt must be a string, a list of strings, or null");
    }
    try {
      const item = service.setUseAt(request.params.itemId, value as string | string[] | null);
      if (item === "ITEM_NOT_FOUND") {
        return reply.code(404).send({ error: { code: "ITEM_NOT_FOUND", message: `Unknown library item: ${request.params.itemId}` } });
      }
      await steps.setUseAt(item.id, item.useAt ?? []);
      return item;
    } catch (error) {
      if (error instanceof UseAtError) return invalid(reply, "INVALID_USE_AT", error.message);
      throw error;
    }
  });

  app.post<{ Params: { itemId: string }; Querystring: { orientation?: string }; Body: unknown }>(
    "/api/v1/pipgm/items/:itemId/canva/export-package",
    async (request, reply) => {
      const orientations = String(request.query?.orientation ?? "landscape")
        .split(",")
        .map((o) => o.trim());
      if (orientations.length === 0 || !orientations.every((o) => o === "landscape" || o === "portrait")) {
        return invalid(reply, "INVALID_ORIENTATION", "orientation must be landscape, portrait or both separated by a comma");
      }
      let source: Parameters<typeof packages.accept>[1];
      if (Buffer.isBuffer(request.body)) {
        source = { zip: request.body };
      } else {
        const pages = (request.body as { pages?: unknown } | null)?.pages;
        if (!Array.isArray(pages) || pages.length === 0) {
          return invalid(reply, "INVALID_PACKAGE", "send a zip (Content-Type: application/zip) or JSON {pages:[{filename, dataBase64}]}");
        }
        const files: Array<{ filename: string; mimeType: string; data: Buffer }> = [];
        for (const page of pages as Array<Record<string, unknown>>) {
          const filename = typeof page.filename === "string" ? page.filename : "";
          const mimeType = (typeof page.mimeType === "string" && page.mimeType) || imageTypeOf(filename);
          if (!filename || !mimeType || !mimeType.startsWith("image/") || typeof page.dataBase64 !== "string") {
            return invalid(reply, "INVALID_PACKAGE", "every page needs a filename, an image mimeType (or an image file extension) and dataBase64");
          }
          files.push({ filename, mimeType, data: Buffer.from(page.dataBase64, "base64") });
        }
        const numbered = numberPages(files);
        // an explicit pageNumber on every page wins over the number found in the file name
        const explicit = (pages as Array<Record<string, unknown>>).every((p) => Number.isInteger(p.pageNumber) && (p.pageNumber as number) > 0);
        source = {
          pages: explicit
            ? (pages as Array<Record<string, unknown>>)
                .map((p, i) => ({ ...files[i]!, filename: files[i]!.filename.split("/").pop()!, pageNumber: p.pageNumber as number }))
                .sort((a, b) => a.pageNumber - b.pageNumber)
            : numbered
        };
      }
      const accepted = packages.accept(request.params.itemId, source, orientations as Array<"landscape" | "portrait">);
      if (accepted === "ITEM_NOT_FOUND") {
        return reply.code(404).send({ error: { code: "ITEM_NOT_FOUND", message: `Unknown library item: ${request.params.itemId}` } });
      }
      if (accepted === "NOT_CANVA_ITEM") {
        return reply.code(422).send({ error: { code: "NOT_CANVA_ITEM", message: "Only Canva items take an export package" } });
      }
      if (accepted === "BUSY") {
        return reply.code(409).send({ error: { code: "PACKAGE_IN_PROGRESS", message: "A package for this item is still being processed" } });
      }
      return reply.code(202).header("location", `/api/v1/pipgm/tasks/${accepted.taskId}`).send(accepted);
    }
  );

  app.get<{ Params: { taskId: string } }>("/api/v1/pipgm/tasks/:taskId", async (request, reply) => {
    const task = packages.get(request.params.taskId);
    if (!task) return reply.code(404).send({ error: { code: "TASK_NOT_FOUND", message: `Unknown task: ${request.params.taskId}` } });
    return task;
  });

  // ---- Prepared step pictures ------------------------------------------------
  const orientationOf = (value: unknown): PiPgmOrientation | null =>
    value === undefined || value === "landscape" ? "landscape" : value === "portrait" ? "portrait" : null;

  app.get<{ Params: { itemId: string }; Querystring: { orientation?: string } }>("/api/v1/pipgm/items/:itemId/steps", async (request, reply) => {
    const orientation = orientationOf(request.query?.orientation);
    if (!orientation) return invalid(reply, "INVALID_ORIENTATION", "orientation must be landscape or portrait");
    const list = await steps.steps(request.params.itemId, orientation);
    if (!list) {
      return reply.code(404).send({ error: { code: "ITEM_NOT_FOUND", message: `Unknown library item: ${request.params.itemId}` } });
    }
    const base = `/api/v1/pipgm/items/${encodeURIComponent(request.params.itemId)}/steps`;
    return {
      orientation,
      prepare: steps.status(request.params.itemId, orientation),
      steps: list.map((s) => ({
        ...s,
        ...(s.prepared
          ? { imageUrl: `${base}/${s.step}/image.png?orientation=${orientation}`, thumbnailUrl: `${base}/${s.step}/thumbnail.jpg?orientation=${orientation}` }
          : {})
      }))
    };
  });

  app.post<{ Params: { itemId: string }; Body: { orientation?: unknown } }>("/api/v1/pipgm/items/:itemId/prepare", async (request, reply) => {
    const orientation = orientationOf(request.body?.orientation);
    if (!orientation) return invalid(reply, "INVALID_ORIENTATION", "orientation must be landscape or portrait");
    const result = steps.prepare(request.params.itemId, orientation);
    if (result === "ITEM_NOT_FOUND") {
      return reply.code(404).send({ error: { code: "ITEM_NOT_FOUND", message: `Unknown library item: ${request.params.itemId}` } });
    }
    if (result === "NOT_STILL_ITEM") {
      return reply.code(422).send({ error: { code: "NOT_STILL_ITEM", message: "Only slide, hymn, image and Canva items have step pictures" } });
    }
    return reply.code(202).send(result);
  });

  for (const [suffix, thumb, type] of [["image.png", false, "image/png"], ["thumbnail.jpg", true, "image/jpeg"]] as const) {
    app.get<{ Params: { itemId: string; step: string }; Querystring: { orientation?: string } }>(
      `/api/v1/pipgm/items/:itemId/steps/:step/${suffix}`,
      async (request, reply) => {
        const orientation = orientationOf(request.query?.orientation);
        if (!orientation) return invalid(reply, "INVALID_ORIENTATION", "orientation must be landscape or portrait");
        const step = Number(request.params.step);
        if (!Number.isInteger(step) || step < 0) return invalid(reply, "INVALID_STEP", "step must be a whole number");
        const bytes = thumb
          ? await steps.thumbnail(request.params.itemId, step, orientation)
          : await steps.image(request.params.itemId, step, orientation);
        if (!bytes) {
          return reply.code(404).send({ error: { code: "STEP_NOT_PREPARED", message: "That step has no prepared picture; POST .../prepare first" } });
        }
        return reply.type(type).header("cache-control", "no-cache").send(bytes);
      }
    );
  }

  app.get("/api/v1/pipgm/feeders", async () => {
    const feeders = publisher.current;
    return {
      enabled: feeders !== null,
      feeds: feeders ? feeders.status() : {},
      ...(feeders ? feeders.encoderInfo() : {})
    };
  });

  // Publishing of PiPGM1-3 to MediaMTX, switched at runtime (replaces the PIPGM_PUBLISH_* env switch).
  app.get("/api/v1/pipgm/publish", async () => publisher.snapshot());
  app.put<{ Body: { enabled?: unknown; rtspBase?: unknown; audio?: unknown } }>("/api/v1/pipgm/publish", async (request, reply) => {
    const result = await publisher.apply(request.body ?? {});
    if (!result.ok) return invalid(reply, result.code, result.message);
    return reply.code(200).send(publisher.snapshot());
  });

  // Local audio (TTS straight to an HDMI sound card) and the output pigateway says reaches the PA.
  const localAudioView = () => ({ ...localAudio.config(), configured: localAudio.configured, ...localAudio.status() });
  app.get("/api/v1/pipgm/local-audio", async () => localAudioView());
  app.put<{ Body: { enabled?: unknown; devices?: unknown } }>("/api/v1/pipgm/local-audio", async (request, reply) => {
    const body = request.body ?? {};
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") return invalid(reply, "INVALID_ENABLED", "enabled must be a boolean");
    const devices: Partial<Record<SoundOutput, string | null>> = {};
    if (body.devices !== undefined) {
      if (!body.devices || typeof body.devices !== "object" || Array.isArray(body.devices)) return invalid(reply, "INVALID_DEVICES", "devices must be an object like {\"hdmi0\": \"hdmi:CARD=vc4hdmi0\"}");
      for (const [name, device] of Object.entries(body.devices as Record<string, unknown>)) {
        if (!isSoundOutput(name)) return invalid(reply, "INVALID_DEVICES", `unknown output ${name} (use ${SOUND_OUTPUTS.join(", ")})`);
        if (device === null) devices[name] = null;
        else if (typeof device === "string" && ALSA_DEVICE.test(device)) devices[name] = device;
        else return invalid(reply, "INVALID_DEVICES", `${name} needs an ALSA device name (letters, digits and . _ : , = / -) or null`);
      }
    }
    localAudio.configure({ ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}), devices });
    localFile.write(localAudio.config());
    return reply.code(200).send(localAudioView());
  });
  app.get("/api/v1/pipgm/audio/sound-output", async () => soundOutput.snapshot());
  app.put<{ Body: { output?: unknown; source?: unknown } }>("/api/v1/pipgm/audio/sound-output", async (request, reply) => {
    const body = request.body ?? {};
    if (body.output !== null && !isSoundOutput(body.output)) return invalid(reply, "INVALID_OUTPUT", `output must be ${SOUND_OUTPUTS.join(", ")} or null`);
    soundOutput.set(body.output, typeof body.source === "string" ? body.source.slice(0, 40) : "api");
    return reply.code(200).send(soundOutput.snapshot());
  });
  app.post<{ Body: { itemId?: unknown; level?: unknown; volume?: unknown; dryRun?: unknown } }>("/api/v1/pipgm/audio/speak", async (request, reply) => {
    const body = request.body ?? {};
    const itemId = typeof body.itemId === "string" ? body.itemId.trim() : "";
    if (!itemId) return invalid(reply, "ITEM_ID_REQUIRED", "itemId is required");
    if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") return invalid(reply, "INVALID_DRY_RUN", "dryRun must be a boolean");
    const resolved = resolveVolume(body.volume, body.level);
    if (!resolved.ok) return invalid(reply, resolved.code, resolved.message);
    const output = soundOutput.current();
    if (!output) {
      return reply.code(409).send({ error: { code: "SOUND_OUTPUT_UNKNOWN", message: "no Pi HDMI output is currently reported to reach the PA (pigateway has not told us, or the report is stale, or none is routed to it)" } });
    }
    const item = service.getLibraryItem(itemId);
    if (!item) return reply.code(404).send({ error: { code: "ITEM_NOT_FOUND", message: `Unknown PiPGM item: ${itemId}` } });
    if (item.kind !== "audio" || !item.audio) return invalid(reply, "ITEM_NOT_AUDIO", `Item ${itemId} is not an audio item`);
    const audio = body.dryRun === true ? Buffer.alloc(0) : await service.readAudioItemBytes(itemId);
    if (!audio) return reply.code(404).send({ error: { code: "ITEM_NOT_FOUND", message: `Item ${itemId} has no sound file` } });
    // The same gain cap as the feeds; the default volume is the "normal" level.
    const volume = Math.min(resolved.volume ?? service.audioLevels.normal, service.maxAudioVolume);
    const result = await localAudio.play({ audio, output, volume, itemId, dryRun: body.dryRun === true });
    if (!result.ok) {
      const status = result.code === "LOCAL_AUDIO_NOT_CONFIGURED" ? 409 : result.code === "NO_DEVICE_FOR_OUTPUT" ? 409 : result.code === "BAD_AUDIO" ? 422 : 502;
      return reply.code(status).send({ error: { code: result.code, message: result.message } });
    }
    return reply.code(200).send({ played: !result.dryRun, dryRun: result.dryRun, output: result.output, device: result.device, volume: result.volume, cappedAt: service.maxAudioVolume });
  });
  app.post("/api/v1/pipgm/audio/speak/stop", async (_request, reply) => {
    localAudio.stop();
    return reply.code(200).send(localAudioView());
  });

  // The stage page is silent unless opened with ?audio=1 (the link the sound-capturing page worker uses),
  // so a preview at a desk or a screenshot never plays the feed's sound a second time.
  app.get<{ Params: { pipelineId: string }; Querystring: { audio?: string } }>("/pipgm/:pipelineId/stage", async (request, reply) => {
    const pipeline = service.getPipeline(request.params.pipelineId);
    if (!pipeline) return notFound(reply, request.params.pipelineId);
    const silent = request.query?.audio !== "1";
    return reply.type("text/html; charset=utf-8").send(renderPiPgmStageHtml(pipeline, { silent }));
  });

  app.get<{ Params: { pipelineId: string }; Querystring: FrameQuery }>(
    "/api/v1/pipgm/pipelines/:pipelineId/frame.png",
    async (request, reply) => {
      const pipeline = service.getPipeline(request.params.pipelineId);
      if (!pipeline) return notFound(reply, request.params.pipelineId);
      const frame = parseFrameQuery(request.query ?? {}, pipeline.resolution);
      if (!frame.ok) return invalid(reply, "INVALID_FRAME_SIZE", frame.message);
      try {
        if (pipeline.activeItemId && !pipeline.fadeToBlack) {
          if (frame.variantOptions) {
            const cached =
              (await steps.lookupVariant(pipeline, frame.variantOptions)) ??
              (await steps.renderCustomVariant(pipeline.activeItemId, pipeline.currentStep, frame.variantOptions));
            if (cached) {
              return reply
                .type("image/png")
                .header("cache-control", "no-cache")
                .header("x-piprogram-composited", "1")
                .send(cached);
            }
            const slidePng = await renderFrame({
              html: renderPiPgmStageHtml(pipeline, { transparent: true, silent: true }),
              width: pipeline.resolution.width,
              height: pipeline.resolution.height,
              transparent: true
            });
            if (isSupportedImageBuffer(slidePng)) {
              try {
                const composited = await ffmpegRenderCustomVariant(slidePng, frame.variantOptions);
                return reply
                  .type("image/png")
                  .header("cache-control", "no-cache")
                  .header("x-piprogram-composited", "1")
                  .send(composited);
              } catch {
                // Fall back to the transparent native-aspect slide for the caller to composite.
              }
            }
            return reply.type("image/png").header("cache-control", "no-cache").send(slidePng);
          } else if (!frame.alpha) {
            const cached = await steps.lookupVariant(pipeline, { width: frame.width, height: frame.height });
            if (cached) {
              return reply.type("image/png").header("cache-control", "no-cache").send(cached);
            }
          }
        }
        const png = await renderFrame({
          html: renderPiPgmStageHtml(pipeline, { transparent: frame.alpha, silent: true }),
          width: frame.width,
          height: frame.height,
          transparent: frame.alpha
        });
        return reply.type("image/png").header("cache-control", "no-cache").send(png);
      } catch (error) {
        if (error instanceof FrameRendererUnavailableError) {
          return reply.code(503).send({ error: { code: "FRAME_RENDERER_UNAVAILABLE", message: error.message } });
        }
        return reply.code(500).send({
          error: { code: "FRAME_RENDER_FAILED", message: error instanceof Error ? error.message : "Frame render failed" }
        });
      }
    }
  );

  // ---- Pipelines -----------------------------------------------------------

  app.get<{ Querystring: { includeHidden?: string } }>("/api/v1/pipgm/pipelines", async (request) => ({
    items: service.listPipelines(request.query?.includeHidden !== "false")
  }));

  app.get<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId", async (request, reply) => {
    const pipeline = service.getPipeline(request.params.pipelineId);
    if (!pipeline) return notFound(reply, request.params.pipelineId);
    return reply.code(200).send(pipeline);
  });

  app.put<{
    Params: { pipelineId: string };
    Body: { orientation?: unknown; hidden?: unknown; linked?: unknown; fadeDurationMs?: unknown; keyColor?: unknown };
  }>("/api/v1/pipgm/pipelines/:pipelineId/config", async (request, reply) => {
    if (!service.isValidPipelineId(request.params.pipelineId)) return notFound(reply, request.params.pipelineId);
    const body = request.body ?? {};
    if (body.orientation !== undefined && body.orientation !== "landscape" && body.orientation !== "portrait") {
      return invalid(reply, "INVALID_ORIENTATION", "orientation must be 'landscape' or 'portrait'");
    }
    if (body.hidden !== undefined && typeof body.hidden !== "boolean") {
      return invalid(reply, "INVALID_HIDDEN", "hidden must be a boolean");
    }
    if (body.linked !== undefined && typeof body.linked !== "boolean") {
      return invalid(reply, "INVALID_LINKED", "linked must be a boolean");
    }
    if (
      body.fadeDurationMs !== undefined &&
      (typeof body.fadeDurationMs !== "number" ||
        !Number.isFinite(body.fadeDurationMs) ||
        body.fadeDurationMs < 0 ||
        body.fadeDurationMs > 10000)
    ) {
      return invalid(reply, "INVALID_FADE_DURATION", "fadeDurationMs must be between 0 and 10000");
    }
    if (body.keyColor !== undefined && body.keyColor !== null && (typeof body.keyColor !== "string" || !/^#[0-9a-fA-F]{6}$/.test(body.keyColor))) {
      return invalid(reply, "INVALID_KEY_COLOR", "keyColor must be #rrggbb or null");
    }
    const updated = service.updatePipelineConfig(request.params.pipelineId, {
      ...(body.keyColor !== undefined ? { keyColor: body.keyColor as string | null } : {}),
      ...(body.orientation !== undefined ? { orientation: body.orientation as PiPgmOrientation } : {}),
      ...(body.hidden !== undefined ? { hidden: body.hidden as boolean } : {}),
      ...(body.linked !== undefined ? { linked: body.linked as boolean } : {}),
      ...(body.fadeDurationMs !== undefined ? { fadeDurationMs: body.fadeDurationMs as number } : {})
    });
    return reply.code(200).send(updated);
  });

  app.post<{ Params: { pipelineId: string } }>(
    "/api/v1/pipgm/pipelines/:pipelineId/sync-piswitch",
    async (request, reply) => {
      if (!service.isValidPipelineId(request.params.pipelineId)) return notFound(reply, request.params.pipelineId);
      const client = service.getPiSwitchClient();
      if (!client) {
        return reply.code(503).send({
          error: {
            code: "PISWITCH_NOT_CONFIGURED",
            message: "piswitch integration is not configured (set PISWITCH_URL)"
          }
        });
      }
      const result = await service.syncToPiSwitch(request.params.pipelineId);
      if (!result) {
        return reply.code(502).send({
          error: {
            code: "PISWITCH_SYNC_FAILED",
            message: "Failed to sync slide to piswitch media pool"
          }
        });
      }
      return reply.code(200).send({
        pipelineId: request.params.pipelineId,
        synced: true,
        slideBuffer: result
      });
    }
  );

  app.post<{
    Params: { pipelineId: string };
    Body: {
      action?: unknown;
      stepIndex?: unknown;
      itemId?: unknown;
      entryId?: unknown;
      itemIndex?: unknown;
      advanceItemOnEnd?: unknown;
      sync?: unknown;
    };
  }>("/api/v1/pipgm/pipelines/:pipelineId/control", async (request, reply) => {
    if (!service.isValidPipelineId(request.params.pipelineId)) return notFound(reply, request.params.pipelineId);
    const body = request.body ?? {};
    const action = String(body.action ?? "") as PiPgmControlAction;
    if (!VALID_CONTROL_ACTIONS.has(action)) {
      return invalid(reply, "INVALID_CONTROL_ACTION", `action must be one of: ${[...VALID_CONTROL_ACTIONS].join(", ")}`);
    }
    const stepIndex = body.stepIndex !== undefined ? Number(body.stepIndex) : undefined;
    if (stepIndex !== undefined && (!Number.isInteger(stepIndex) || stepIndex < 0)) {
      return invalid(reply, "INVALID_STEP_INDEX", "stepIndex must be a non-negative integer");
    }
    const itemIndex = body.itemIndex !== undefined ? Number(body.itemIndex) : undefined;
    if (itemIndex !== undefined && (!Number.isInteger(itemIndex) || itemIndex < 0)) {
      return invalid(reply, "INVALID_ITEM_INDEX", "itemIndex must be a non-negative integer");
    }
    const updated = service.control(request.params.pipelineId, {
      action,
      ...(stepIndex !== undefined ? { stepIndex } : {}),
      ...(typeof body.itemId === "string" ? { itemId: body.itemId } : {}),
      ...(typeof body.entryId === "string" ? { entryId: body.entryId } : {}),
      ...(itemIndex !== undefined ? { itemIndex } : {}),
      ...(typeof body.advanceItemOnEnd === "boolean" ? { advanceItemOnEnd: body.advanceItemOnEnd } : {}),
      ...(typeof body.sync === "boolean" ? { sync: body.sync } : {})
    });
    return reply.code(200).send(updated);
  });

  app.post<{
    Params: { pipelineId: string };
    Body: { fadeToBlack?: unknown; toggle?: unknown; durationMs?: unknown; sync?: unknown };
  }>("/api/v1/pipgm/pipelines/:pipelineId/ftb", async (request, reply) => {
    if (!service.isValidPipelineId(request.params.pipelineId)) return notFound(reply, request.params.pipelineId);
    const body = request.body ?? {};
    if (body.fadeToBlack !== undefined && typeof body.fadeToBlack !== "boolean") {
      return invalid(reply, "INVALID_FTB_VALUE", "fadeToBlack must be a boolean");
    }
    const durationMs = body.durationMs !== undefined ? Number(body.durationMs) : undefined;
    if (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 10000)) {
      return invalid(reply, "INVALID_FADE_DURATION", "durationMs must be between 0 and 10000");
    }
    const updated = service.setFadeToBlack(request.params.pipelineId, {
      ...(typeof body.fadeToBlack === "boolean" ? { fadeToBlack: body.fadeToBlack } : {}),
      ...(typeof body.toggle === "boolean" ? { toggle: body.toggle } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(typeof body.sync === "boolean" ? { sync: body.sync } : {})
    });
    return reply.code(200).send(updated);
  });

  app.post<{
    Params: { pipelineId: string };
    Body: { audioEnabled?: unknown; toggle?: unknown; volume?: unknown; level?: unknown; armSeconds?: unknown; sync?: unknown };
  }>("/api/v1/pipgm/pipelines/:pipelineId/audio", async (request, reply) => {
    if (!service.isValidPipelineId(request.params.pipelineId)) return notFound(reply, request.params.pipelineId);
    const body = request.body ?? {};
    if (body.audioEnabled !== undefined && typeof body.audioEnabled !== "boolean") {
      return invalid(reply, "INVALID_AUDIO_VALUE", "audioEnabled must be a boolean");
    }
    const resolved = resolveVolume(body.volume, body.level);
    if (!resolved.ok) return invalid(reply, resolved.code, resolved.message);
    const volume = resolved.volume;
    const armSeconds = body.armSeconds !== undefined ? Number(body.armSeconds) : undefined;
    if (
      armSeconds !== undefined &&
      (!Number.isFinite(armSeconds) || armSeconds < 1 || armSeconds > MAX_AUDIO_ARM_SECONDS)
    ) {
      return invalid(reply, "INVALID_ARM_SECONDS", `armSeconds must be between 1 and ${MAX_AUDIO_ARM_SECONDS}`);
    }
    const updated = service.setAudio(request.params.pipelineId, {
      ...(typeof body.audioEnabled === "boolean" ? { audioEnabled: body.audioEnabled } : {}),
      ...(typeof body.toggle === "boolean" ? { toggle: body.toggle } : {}),
      ...(volume !== undefined ? { volume } : {}),
      ...(armSeconds !== undefined ? { armSeconds } : {}),
      ...(typeof body.sync === "boolean" ? { sync: body.sync } : {})
    });
    return reply.code(200).send(updated);
  });

  app.post<{ Params: { pipelineId: string }; Body: { itemId?: unknown; loop?: unknown; volume?: unknown; level?: unknown } }>(
    "/api/v1/pipgm/pipelines/:pipelineId/audio/play",
    async (request, reply) => {
      if (!service.isValidPipelineId(request.params.pipelineId)) return notFound(reply, request.params.pipelineId);
      const body = request.body ?? {};
      const itemId = typeof body.itemId === "string" ? body.itemId.trim() : "";
      if (!itemId) return invalid(reply, "ITEM_ID_REQUIRED", "itemId is required");
      if (body.loop !== undefined && typeof body.loop !== "boolean") {
        return invalid(reply, "INVALID_LOOP", "loop must be a boolean");
      }
      const resolved = resolveVolume(body.volume, body.level);
      if (!resolved.ok) return invalid(reply, resolved.code, resolved.message);
      const volume = resolved.volume;
      const result = service.playAudio(request.params.pipelineId, {
        itemId,
        ...(typeof body.loop === "boolean" ? { loop: body.loop } : {}),
        ...(volume !== undefined ? { volume } : {})
      });
      if (result.ok) return reply.code(200).send(result.pipeline);
      if (result.code === "AUDIO_NOT_ARMED") {
        return reply.code(409).send({
          error: { code: "AUDIO_NOT_ARMED", message: "Sound is not armed on this pipeline; arm it with POST .../audio first" }
        });
      }
      if (result.code === "ITEM_NOT_FOUND") {
        return reply.code(404).send({ error: { code: "ITEM_NOT_FOUND", message: `Unknown PiPGM item: ${itemId}` } });
      }
      if (result.code === "ITEM_NOT_AUDIO") {
        return invalid(reply, "ITEM_NOT_AUDIO", `Item ${itemId} is not an audio item`);
      }
      return notFound(reply, request.params.pipelineId);
    }
  );

  app.post<{ Params: { pipelineId: string } }>(
    "/api/v1/pipgm/pipelines/:pipelineId/audio/stop",
    async (request, reply) => {
      if (!service.isValidPipelineId(request.params.pipelineId)) return notFound(reply, request.params.pipelineId);
      return reply.code(200).send(service.stopAudio(request.params.pipelineId));
    }
  );

  // The volume behind each level name, and the cap that applies to all of them.
  app.get("/api/v1/pipgm/audio/levels", async (_request, reply) => {
    return reply.code(200).send({ levels: service.audioLevels, maxVolume: service.maxAudioVolume });
  });

  // Kill switch: silences every pipeline, clears the tracks and disarms. Needs the API key like any write.
  app.post("/api/v1/pipgm/audio/kill", async (_request, reply) => {
    localAudio.stop();
    return reply.code(200).send({ items: service.killAudio() });
  });

  // Render a phrase to a WAV ahead of time; play it later with audio/play. Needs the API key like any write.
  app.post<{ Body: { text?: unknown; voice?: unknown; title?: unknown } }>("/api/v1/pipgm/tts/prepare", async (request, reply) => {
    const body = request.body ?? {};
    if (typeof body.text !== "string") return invalid(reply, "TEXT_REQUIRED", "text is required");
    if (body.voice !== undefined && typeof body.voice !== "string") {
      return invalid(reply, "INVALID_VOICE", "voice must be a string");
    }
    const result = await service.prepareSpeech({
      text: body.text,
      ...(typeof body.voice === "string" ? { voice: body.voice } : {}),
      ...(typeof body.title === "string" ? { title: body.title } : {})
    });
    if (result.ok) return reply.code(result.cached ? 200 : 201).send({ item: result.item, cached: result.cached });
    const status =
      result.code === "TTS_NOT_CONFIGURED" ? 503
      : result.code === "TTS_BUSY" ? 429
      : result.code === "TTS_FAILED" || result.code === "TTS_BAD_AUDIO" ? 502
      : 422;
    return reply.code(status).send({ error: { code: result.code, message: result.message } });
  });

  app.put<{ Params: { pipelineId: string }; Body: { itemId?: unknown } }>(
    "/api/v1/pipgm/pipelines/:pipelineId/basic-image",
    async (request, reply) => {
      if (!service.isValidPipelineId(request.params.pipelineId)) return notFound(reply, request.params.pipelineId);
      const itemId = request.body?.itemId;
      if (itemId !== null && typeof itemId !== "string") {
        return invalid(reply, "INVALID_ITEM_ID", "itemId must be an image item id, or null to clear");
      }
      const result = service.setBasicImage(request.params.pipelineId, itemId);
      if (result === "ITEM_NOT_FOUND") {
        return reply.code(404).send({ error: { code: "ITEM_NOT_FOUND", message: `Unknown PiPGM item: ${itemId}` } });
      }
      if (result === "ITEM_NOT_IMAGE") {
        return invalid(reply, "ITEM_NOT_IMAGE", `Item ${itemId} is not an image item`);
      }
      return reply.code(200).send(result);
    }
  );

  app.post<{ Params: { pipelineId: string }; Body: { itemId?: unknown; cueImmediately?: unknown } }>(
    "/api/v1/pipgm/pipelines/:pipelineId/playlist",
    async (request, reply) => {
      if (!service.isValidPipelineId(request.params.pipelineId)) return notFound(reply, request.params.pipelineId);
      const itemId = typeof request.body?.itemId === "string" ? request.body.itemId.trim() : "";
      if (!itemId) return invalid(reply, "ITEM_ID_REQUIRED", "itemId is required");
      const updated = service.addItemToPipeline(
        request.params.pipelineId,
        itemId,
        request.body?.cueImmediately === true
      );
      if (!updated) {
        return reply.code(404).send({ error: { code: "ITEM_NOT_FOUND", message: `Unknown PiPGM item: ${itemId}` } });
      }
      return reply.code(200).send(updated);
    }
  );

  // Replace or reorder the playlist atomically. Needs the API key like any write.
  app.put<{ Params: { pipelineId: string }; Body: { itemIds?: unknown } }>(
    "/api/v1/pipgm/pipelines/:pipelineId/playlist/order",
    async (request, reply) => {
      if (!service.isValidPipelineId(request.params.pipelineId)) return notFound(reply, request.params.pipelineId);
      const itemIds = request.body?.itemIds;
      if (!Array.isArray(itemIds) || !itemIds.every((id) => typeof id === "string" && id.trim() !== "")) {
        return invalid(reply, "INVALID_ITEM_IDS", "itemIds must be an array of item ids");
      }
      const result = service.setPlaylistOrder(request.params.pipelineId, itemIds as string[]);
      if (!result) return notFound(reply, request.params.pipelineId);
      if ("error" in result) {
        return reply.code(422).send({
          error: {
            code: "UNKNOWN_ITEMS",
            message: `Not in the library: ${result.ids.join(", ")}`,
            ids: result.ids
          }
        });
      }
      return reply.code(200).send(result);
    }
  );

  // The whole playlist as one ordered list of steps (for a "coming up" strip). Reads are open.
  app.get<{ Params: { pipelineId: string } }>(
    "/api/v1/pipgm/pipelines/:pipelineId/playlist/steps",
    async (request, reply) => {
      const pipeline = service.getPipeline(request.params.pipelineId);
      if (!pipeline) return notFound(reply, request.params.pipelineId);
      const out: Array<{
        itemId: string;
        entryId: string | null;
        itemIndex: number;
        itemTitle: string;
        itemKind: string;
        stepIndex: number;
        label: string;
        thumbnailUrl: string | null;
        isActive: boolean;
      }> = [];
      for (const [itemIndex, item] of pipeline.playlist.entries()) {
        let prepared = new Map<number, boolean>();
        try {
          const list = await steps.steps(item.id, pipeline.orientation);
          prepared = new Map((list ?? []).map((s) => [s.step, s.prepared]));
        } catch {
          // The store is down: the steps are listed without thumbnails.
        }
        const base = `/api/v1/pipgm/items/${encodeURIComponent(item.id)}/steps`;
        for (const [stepIndex, step] of item.steps.entries()) {
          out.push({
            itemId: item.id,
            entryId: item.entryId ?? null,
            itemIndex,
            itemTitle: item.title,
            itemKind: item.kind,
            stepIndex,
            label: step.label,
            thumbnailUrl: prepared.get(stepIndex)
              ? `${base}/${stepIndex}/thumbnail.jpg?orientation=${pipeline.orientation}`
              : null,
            isActive: (item.entryId ? pipeline.activeEntryId === item.entryId : pipeline.activeItemId === item.id) && pipeline.currentStep === stepIndex
          });
        }
      }
      return reply.code(200).send({
        pipelineId: pipeline.id,
        orientation: pipeline.orientation,
        activeItemId: pipeline.activeItemId,
        activeEntryId: pipeline.activeEntryId,
        currentStep: pipeline.currentStep,
        steps: out
      });
    }
  );

  app.delete<{ Params: { pipelineId: string; itemId: string } }>(
    "/api/v1/pipgm/pipelines/:pipelineId/playlist/:itemId",
    async (request, reply) => {
      if (!service.isValidPipelineId(request.params.pipelineId)) return notFound(reply, request.params.pipelineId);
      const updated = service.removeItemFromPipeline(request.params.pipelineId, request.params.itemId);
      if (!updated) {
        return reply.code(404).send({
          error: { code: "ITEM_NOT_FOUND", message: `Unknown PiPGM item on ${request.params.pipelineId}: ${request.params.itemId}` }
        });
      }
      return reply.code(200).send(updated);
    }
  );

  // ---- Saved playlists ---------------------------------------------------------
  app.get("/api/v1/pipgm/playlists", async (_request, reply) => {
    try {
      return reply.code(200).send({ items: await playlists.list() });
    } catch (error) {
      return storageDown(reply, error);
    }
  });

  app.post<{ Body: unknown }>("/api/v1/pipgm/playlists", async (request, reply) => {
    const checked = validatePlaylist(request.body);
    if (!checked.ok) return invalidPlaylist(reply, checked.errors);
    try {
      return reply.code(201).send(await playlists.save(checked.value));
    } catch (error) {
      return storageDown(reply, error);
    }
  });

  // A draft playlist for a day from the items' useAt dates. Nothing is saved or loaded; it is a POST because it is a
  // computation with a body, so it needs the API key like any other POST.
  app.post<{ Body: { date?: unknown; orientation?: unknown; name?: unknown } }>("/api/v1/pipgm/playlists/generate", async (request, reply) => {
    const { date, orientation, name } = request.body ?? {};
    if (typeof date !== "string") return invalid(reply, "DATE_REQUIRED", "date is required (YYYY-MM-DD)");
    if (orientation !== undefined && orientation !== "landscape" && orientation !== "portrait") {
      return invalid(reply, "INVALID_ORIENTATION", "orientation must be landscape or portrait");
    }
    if (name !== undefined && typeof name !== "string") return invalid(reply, "INVALID_NAME", "name must be a string");
    let items;
    try {
      items = service.itemsForDate(date);
    } catch (error) {
      if (error instanceof UseAtError) return invalid(reply, "INVALID_DATE", error.message);
      throw error;
    }
    return reply.code(200).send({
      date,
      draft: {
        schema: "piprogram.playlist/1",
        name: name?.trim() || `Draft ${date}`,
        ...(orientation ? { orientation } : {}),
        items: items.map(savedItemOf)
      }
    });
  });

  app.get<{ Params: { playlistId: string } }>("/api/v1/pipgm/playlists/:playlistId", async (request, reply) => {
    try {
      const found = await playlists.get(request.params.playlistId);
      return found ? reply.code(200).send(found) : playlistNotFound(reply, request.params.playlistId);
    } catch (error) {
      return storageDown(reply, error);
    }
  });

  app.put<{ Params: { playlistId: string }; Body: unknown }>("/api/v1/pipgm/playlists/:playlistId", async (request, reply) => {
    const id = request.params.playlistId;
    if (!isPlaylistId(id)) return playlistNotFound(reply, id);
    const checked = validatePlaylist(request.body);
    if (!checked.ok) return invalidPlaylist(reply, checked.errors);
    try {
      const saved = await playlists.save(checked.value, id);
      return saved ? reply.code(200).send(saved) : playlistNotFound(reply, id);
    } catch (error) {
      return storageDown(reply, error);
    }
  });

  app.delete<{ Params: { playlistId: string } }>("/api/v1/pipgm/playlists/:playlistId", async (request, reply) => {
    try {
      return (await playlists.delete(request.params.playlistId))
        ? reply.code(204).send()
        : playlistNotFound(reply, request.params.playlistId);
    } catch (error) {
      return storageDown(reply, error);
    }
  });

  // Put a saved playlist on a feed without touching what is on air. Needs the API key like any write.
  app.post<{ Params: { pipelineId: string }; Body: { playlistId?: unknown; mode?: unknown; strict?: unknown } }>(
    "/api/v1/pipgm/pipelines/:pipelineId/playlist/load",
    async (request, reply) => {
      if (!service.isValidPipelineId(request.params.pipelineId)) return notFound(reply, request.params.pipelineId);
      const { playlistId, mode = "replace", strict } = request.body ?? {};
      if (typeof playlistId !== "string" || !playlistId.trim()) return invalid(reply, "PLAYLIST_ID_REQUIRED", "playlistId is required");
      if (mode !== "replace" && mode !== "append") return invalid(reply, "INVALID_MODE", "mode must be replace or append");
      if (strict !== undefined && typeof strict !== "boolean") return invalid(reply, "INVALID_STRICT", "strict must be true or false");
      let saved;
      try {
        saved = await playlists.get(playlistId);
      } catch (error) {
        return storageDown(reply, error);
      }
      if (!saved) return playlistNotFound(reply, playlistId);
      const result = service.loadSavedPlaylist(request.params.pipelineId, saved.items, mode, { strict: strict === true });
      if (!result) return notFound(reply, request.params.pipelineId);
      if ("error" in result) {
        return reply.code(409).send({
          error: { code: "MISSING_ITEMS", message: `${result.missing.length} item(s) are not in the library; nothing was loaded`, missing: result.missing }
        });
      }
      return reply.code(200).send(result);
    }
  );

  // Save a feed's current playlist under a name (a new saved playlist, or replace one with playlistId).
  app.post<{ Params: { pipelineId: string }; Body: { name?: unknown; playlistId?: unknown } }>(
    "/api/v1/pipgm/pipelines/:pipelineId/playlist/save",
    async (request, reply) => {
      const pipeline = service.getPipeline(request.params.pipelineId);
      if (!pipeline) return notFound(reply, request.params.pipelineId);
      const playlistId = request.body?.playlistId;
      if (playlistId !== undefined && (typeof playlistId !== "string" || !isPlaylistId(playlistId))) {
        return invalid(reply, "INVALID_PLAYLIST_ID", "playlistId must be the id of a saved playlist");
      }
      const checked = validatePlaylist({
        name: request.body?.name,
        orientation: pipeline.orientation,
        items: pipeline.playlist.map(savedItemOf)
      });
      if (!checked.ok) return invalidPlaylist(reply, checked.errors);
      try {
        const saved = await playlists.save(checked.value, playlistId);
        if (!saved) return playlistNotFound(reply, String(playlistId));
        return reply.code(playlistId === undefined ? 201 : 200).send(saved);
      } catch (error) {
        return storageDown(reply, error);
      }
    }
  );

  // ---- Library items -------------------------------------------------------

  // The library, filtered: ?type=sound,tts&kind=audio&q=words&usedFrom=2026-11-01&usedTo=2026-11-30&unscheduled=true
  // &sort=newest|oldest|title|used&limit=50&offset=0. Without a query it lists everything, as before.
  app.get<{ Querystring: Record<string, string | undefined> }>("/api/v1/pipgm/items", async (request, reply) => {
    const q = request.query ?? {};
    const list = (v: string | undefined): string[] => (v ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    const query: LibraryQuery = { zone: LIBRARY_ZONE };
    const types = list(q.type);
    if (types.some((t) => !normalizeLibraryType(t))) return invalid(reply, "INVALID_TYPE", "type must be lowercase letters, digits and dashes");
    if (types.length) query.types = types;
    const hymnals = (q.hymnal ?? "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
    if (hymnals.some((h) => !HYMNAL_PREFIX.test(h))) return invalid(reply, "INVALID_HYMNAL", "hymnal must be 1-6 letters, e.g. VK or LV");
    if (hymnals.length) query.hymnals = hymnals;
    const kinds = list(q.kind);
    if (kinds.length) query.kinds = kinds as LibraryQuery["kinds"] & string[];
    if (q.q) query.text = q.q;
    if (q.usedFrom) query.usedFrom = q.usedFrom;
    if (q.usedTo) query.usedTo = q.usedTo;
    if (q.unscheduled === "true" || q.unscheduled === "false") query.unscheduled = q.unscheduled === "true";
    if (q.sort !== undefined) {
      if (q.sort !== "newest" && q.sort !== "oldest" && q.sort !== "title" && q.sort !== "used") return invalid(reply, "INVALID_SORT", "sort must be newest, oldest, title or used");
      query.sort = q.sort;
    }
    for (const name of ["limit", "offset"] as const) {
      if (q[name] === undefined) continue;
      const n = Number(q[name]);
      if (!Number.isInteger(n) || n < (name === "limit" ? 1 : 0)) return invalid(reply, `INVALID_${name.toUpperCase()}`, `${name} must be a whole number`);
      query[name] = n;
    }
    try {
      const page = queryLibrary(service.listLibraryItems(), query);
      return { ...page, standardTypes: STANDARD_LIBRARY_TYPES, hymnalList: hymnalList(page.hymnals.map((h) => h.prefix)) };
    } catch (error) {
      if (error instanceof UseAtError) return invalid(reply, "INVALID_DATE", error.message);
      throw error;
    }
  });

  // Rename an item and/or set its library type (type null = back to the default of its kind).
  app.patch<{ Params: { itemId: string }; Body: { title?: unknown; type?: unknown } }>("/api/v1/pipgm/items/:itemId", async (request, reply) => {
    const body = request.body ?? {};
    if (body.title !== undefined && typeof body.title !== "string") return invalid(reply, "INVALID_TITLE", "title must be a string");
    if (body.type !== undefined && body.type !== null && typeof body.type !== "string") return invalid(reply, "INVALID_TYPE", "type must be a string or null");
    if (body.title === undefined && body.type === undefined) return invalid(reply, "NOTHING_TO_CHANGE", "give title and/or type");
    const result = service.updateItem(request.params.itemId, {
      ...(body.title !== undefined ? { title: body.title as string } : {}),
      ...(body.type !== undefined ? { type: body.type as string | null } : {})
    });
    if (result === "ITEM_NOT_FOUND") {
      return reply.code(404).send({ error: { code: "ITEM_NOT_FOUND", message: `Unknown library item: ${request.params.itemId}` } });
    }
    if (result === "INVALID_TYPE") return invalid(reply, "INVALID_TYPE", "type must be lowercase letters, digits and dashes (at most 32)");
    if (result === "INVALID_TITLE") return invalid(reply, "INVALID_TITLE", "title must be 1-200 characters");
    return result;
  });

  // ---- Active folder: hand-picked items plus the items whose useAt covers the day -----------------
  const activeView = async (date: string) => {
    const byDate = service.itemsForDate(date, { includeAudio: true });
    const manual = await active.list();
    const dateIds = new Set(byDate.map((i) => i.id));
    const manualIds = new Set(manual.map((e) => e.itemId));
    const items = byDate.map((item) => ({ item, reason: manualIds.has(item.id) ? "both" : "date" }));
    for (const entry of manual) {
      const item = service.getLibraryItem(entry.itemId);
      if (item && !dateIds.has(item.id)) items.push({ item, reason: "manual" });
    }
    return { date, items, dateCount: byDate.length, manualCount: manual.length };
  };
  const dateOf = (value: unknown): string | null =>
    value === undefined ? service.todayInZone() : typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;

  app.get<{ Querystring: { date?: string } }>("/api/v1/pipgm/library/active", async (request, reply) => {
    const date = dateOf(request.query?.date);
    if (!date) return invalid(reply, "INVALID_DATE", "date must be YYYY-MM-DD");
    try {
      return await activeView(date);
    } catch (error) {
      return storageDown(reply, error);
    }
  });

  app.put<{ Params: { itemId: string } }>("/api/v1/pipgm/library/active/:itemId", async (request, reply) => {
    if (!service.getLibraryItem(request.params.itemId)) {
      return reply.code(404).send({ error: { code: "ITEM_NOT_FOUND", message: `Unknown library item: ${request.params.itemId}` } });
    }
    try {
      if (!(await active.add(request.params.itemId))) return reply.code(409).send({ error: { code: "ACTIVE_FULL", message: "The active folder is full" } });
      return reply.code(200).send(await activeView(service.todayInZone()));
    } catch (error) {
      return storageDown(reply, error);
    }
  });

  app.delete<{ Params: { itemId: string } }>("/api/v1/pipgm/library/active/:itemId", async (request, reply) => {
    try {
      await active.remove(request.params.itemId);
      return reply.code(200).send(await activeView(service.todayInZone()));
    } catch (error) {
      return storageDown(reply, error);
    }
  });

  // Empties the hand-picked list (items chosen by date stay: change their dates to remove them).
  app.delete("/api/v1/pipgm/library/active", async (_request, reply) => {
    try {
      const removed = await active.clear();
      return reply.code(200).send({ removed, ...(await activeView(service.todayInZone())) });
    } catch (error) {
      return storageDown(reply, error);
    }
  });

  // Saves a playlist from the active folder. Sound items are left out (they play through audio/play, not the
  // playlist) unless includeAudio is true. itemIds picks and orders a subset of the folder.
  app.post<{ Body: { name?: unknown; date?: unknown; orientation?: unknown; itemIds?: unknown; includeAudio?: unknown } }>(
    "/api/v1/pipgm/library/active/playlist",
    async (request, reply) => {
      const body = request.body ?? {};
      const date = dateOf(body.date);
      if (!date) return invalid(reply, "INVALID_DATE", "date must be YYYY-MM-DD");
      if (typeof body.name !== "string" || !body.name.trim()) return invalid(reply, "NAME_REQUIRED", "name is required");
      if (body.orientation !== undefined && body.orientation !== "landscape" && body.orientation !== "portrait") {
        return invalid(reply, "INVALID_ORIENTATION", "orientation must be landscape or portrait");
      }
      if (body.itemIds !== undefined && !(Array.isArray(body.itemIds) && body.itemIds.every((v) => typeof v === "string"))) {
        return invalid(reply, "INVALID_ITEM_IDS", "itemIds must be a list of item ids");
      }
      try {
        const view = await activeView(date);
        let chosen = view.items.map((e) => e.item);
        if (body.itemIds) {
          const byId = new Map(chosen.map((i) => [i.id, i]));
          const unknown = (body.itemIds as string[]).filter((id) => !byId.has(id));
          if (unknown.length) return reply.code(422).send({ error: { code: "NOT_IN_ACTIVE_FOLDER", message: `Not in the active folder: ${unknown.join(", ")}` } });
          chosen = (body.itemIds as string[]).map((id) => byId.get(id)!);
        }
        const skippedAudio = body.includeAudio === true ? 0 : chosen.filter((i) => i.kind === "audio").length;
        if (body.includeAudio !== true) chosen = chosen.filter((i) => i.kind !== "audio");
        const saved = await playlists.save({
          schema: "piprogram.playlist/1",
          name: body.name.trim().slice(0, 120),
          ...(body.orientation ? { orientation: body.orientation as "landscape" | "portrait" } : {}),
          items: chosen.map(savedItemOf)
        });
        return reply.code(201).send({ playlist: saved, skippedAudio });
      } catch (error) {
        return storageDown(reply, error);
      }
    }
  );

  app.get<{ Params: { itemId: string } }>("/api/v1/pipgm/items/:itemId", async (request, reply) => {
    const item = service.getLibraryItem(request.params.itemId);
    if (!item) {
      return reply.code(404).send({ error: { code: "ITEM_NOT_FOUND", message: `Unknown PiPGM item: ${request.params.itemId}` } });
    }
    return reply.code(200).send(item);
  });

  app.post<{
    Body: {
      title?: unknown;
      hymnNumber?: unknown;
      includeTitleSlide?: unknown;
      stanzas?: unknown;
      rawText?: unknown;
      type?: unknown;
      targetPipelineId?: unknown;
      cueImmediately?: unknown;
    };
  }>("/api/v1/pipgm/items/hymn", async (request, reply) => {
    const body = request.body ?? {};
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) return invalid(reply, "TITLE_REQUIRED", "Hymn title is required");
    if (body.targetPipelineId !== undefined && !isPipelineId(service, body.targetPipelineId)) {
      return invalid(reply, "INVALID_PIPELINE_ID", "targetPipelineId must be PiPGM1, PiPGM2, or PiPGM3");
    }
    const item = service.createHymnItem({
      title,
      ...(typeof body.hymnNumber === "string" ? { hymnNumber: body.hymnNumber } : {}),
      ...(typeof body.includeTitleSlide === "boolean" ? { includeTitleSlide: body.includeTitleSlide } : {}),
      ...(Array.isArray(body.stanzas)
        ? { stanzas: body.stanzas as Array<{ stanzaNumber?: string | number; lines: string[]; refrain?: boolean }> }
        : {}),
      ...(typeof body.rawText === "string" ? { rawText: body.rawText } : {}),
      ...(typeof body.type === "string" ? { type: body.type } : {}),
      ...(typeof body.targetPipelineId === "string" ? { targetPipelineId: body.targetPipelineId as PiPgmPipelineId } : {}),
      ...(typeof body.cueImmediately === "boolean" ? { cueImmediately: body.cueImmediately } : {})
    });
    return reply.code(201).send(item);
  });

  app.post<{
    Body: {
      title?: unknown;
      urlOrId?: unknown;
      startSeconds?: unknown;
      endSeconds?: unknown;
      autoplay?: unknown;
      loop?: unknown;
      targetPipelineId?: unknown;
      cueImmediately?: unknown;
    };
  }>("/api/v1/pipgm/items/youtube", async (request, reply) => {
    const body = request.body ?? {};
    if (typeof body.urlOrId !== "string" || !body.urlOrId.trim()) {
      return invalid(reply, "URL_REQUIRED", "urlOrId (a YouTube URL or 11-character ID) is required");
    }
    if (body.targetPipelineId !== undefined && !isPipelineId(service, body.targetPipelineId)) {
      return invalid(reply, "INVALID_PIPELINE_ID", "targetPipelineId must be PiPGM1, PiPGM2, or PiPGM3");
    }
    const item = service.createYouTubeItem({
      urlOrId: body.urlOrId,
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.startSeconds === "number" ? { startSeconds: body.startSeconds } : {}),
      ...(typeof body.endSeconds === "number" ? { endSeconds: body.endSeconds } : {}),
      ...(typeof body.autoplay === "boolean" ? { autoplay: body.autoplay } : {}),
      ...(typeof body.loop === "boolean" ? { loop: body.loop } : {}),
      ...(typeof body.targetPipelineId === "string" ? { targetPipelineId: body.targetPipelineId as PiPgmPipelineId } : {}),
      ...(typeof body.cueImmediately === "boolean" ? { cueImmediately: body.cueImmediately } : {})
    });
    if (!item) return invalid(reply, "INVALID_YOUTUBE_URL", "Could not extract a valid 11-character YouTube video ID");
    return reply.code(201).send(item);
  });

  app.post<{
    Body: {
      kind?: unknown;
      title?: unknown;
      filename?: unknown;
      mimeType?: unknown;
      dataBase64?: unknown;
      fit?: unknown;
      caption?: unknown;
      durationMs?: unknown;
      autoplay?: unknown;
      loop?: unknown;
      targetPipelineId?: unknown;
      cueImmediately?: unknown;
      type?: unknown;
      useAt?: unknown;
      recorded?: unknown;
    };
  }>("/api/v1/pipgm/items/media", async (request, reply) => {
    const body = request.body ?? {};
    if (body.kind !== "video" && body.kind !== "image" && body.kind !== "audio") {
      return invalid(reply, "INVALID_MEDIA_KIND", "kind must be 'video', 'image' or 'audio'");
    }
    const filename = typeof body.filename === "string" ? body.filename.trim() : "";
    if (!filename) return invalid(reply, "FILENAME_REQUIRED", "filename is required");
    if (body.targetPipelineId !== undefined && !isPipelineId(service, body.targetPipelineId)) {
      return invalid(reply, "INVALID_PIPELINE_ID", "targetPipelineId must be PiPGM1, PiPGM2, or PiPGM3");
    }
    if (body.type !== undefined && !normalizeLibraryType(body.type)) {
      return invalid(reply, "INVALID_TYPE", "type must be lowercase letters, digits and dashes (at most 32)");
    }
    let stored = { filename, mimeType: typeof body.mimeType === "string" ? body.mimeType : undefined, dataBase64: typeof body.dataBase64 === "string" ? body.dataBase64 : undefined, durationMs: undefined as number | undefined };
    if (body.kind === "audio") {
      const audio = Buffer.from(typeof body.dataBase64 === "string" ? body.dataBase64 : "", "base64");
      // Any audio format is accepted: ffmpeg converts it (src/audio-upload.ts) unless it is a valid PCM WAV.
      const prepared = await service.prepareAudioUpload(audio, typeof body.mimeType === "string" ? body.mimeType : "", filename);
      if (!prepared.ok) {
        return reply.code(prepared.status).send({ error: { code: prepared.code, message: prepared.message } });
      }
      stored = { filename: prepared.filename, mimeType: prepared.mimeType, dataBase64: prepared.data.toString("base64"), durationMs: prepared.durationMs };
    }
    let item;
    try {
      item = service.createUploadedMediaItem({
        kind: body.kind,
        filename: stored.filename,
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(stored.mimeType !== undefined ? { mimeType: stored.mimeType } : {}),
        ...(stored.dataBase64 !== undefined ? { dataBase64: stored.dataBase64 } : {}),
        ...(body.fit === "contain" || body.fit === "cover" ? { fit: body.fit } : {}),
        ...(typeof body.caption === "string" ? { caption: body.caption } : {}),
        ...(stored.durationMs !== undefined ? { durationMs: stored.durationMs } : typeof body.durationMs === "number" ? { durationMs: body.durationMs } : {}),
        ...(typeof body.autoplay === "boolean" ? { autoplay: body.autoplay } : {}),
        ...(typeof body.loop === "boolean" ? { loop: body.loop } : {}),
        ...(typeof body.targetPipelineId === "string" ? { targetPipelineId: body.targetPipelineId as PiPgmPipelineId } : {}),
        ...(typeof body.cueImmediately === "boolean" ? { cueImmediately: body.cueImmediately } : {}),
        ...(typeof body.type === "string" ? { type: body.type } : {}),
        ...(typeof body.useAt === "string" || (Array.isArray(body.useAt) && body.useAt.every((v) => typeof v === "string")) ? { useAt: body.useAt as string | string[] } : {}),
        ...(body.recorded === true ? { origin: "recording" as const } : {})
      });
    } catch (error) {
      if (error instanceof UseAtError) return invalid(reply, "INVALID_USE_AT", error.message);
      throw error;
    }
    return reply.code(201).send(item);
  });

  app.post<{
    Body: {
      title?: unknown;
      filename?: unknown;
      dataBase64?: unknown;
      animateBulletsByDefault?: unknown;
      slides?: unknown;
      targetPipelineId?: unknown;
      cueImmediately?: unknown;
    };
  }>("/api/v1/pipgm/items/pptx", async (request, reply) => {
    const body = request.body ?? {};
    const filename = typeof body.filename === "string" ? body.filename.trim() : "";
    if (!filename) return invalid(reply, "FILENAME_REQUIRED", "filename is required for .pptx upload");
    if (body.targetPipelineId !== undefined && !isPipelineId(service, body.targetPipelineId)) {
      return invalid(reply, "INVALID_PIPELINE_ID", "targetPipelineId must be PiPGM1, PiPGM2, or PiPGM3");
    }
    const item = service.createPptxItem({
      filename,
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.dataBase64 === "string" ? { dataBase64: body.dataBase64 } : {}),
      ...(typeof body.animateBulletsByDefault === "boolean" ? { animateBulletsByDefault: body.animateBulletsByDefault } : {}),
      ...(Array.isArray(body.slides)
        ? {
            slides: body.slides as Array<{
              slideNumber?: number;
              title: string;
              bullets?: string[];
              notes?: string;
              builds?: Array<{ effect?: PptxAnimationEffect; targetText?: string; durationMs?: number }>;
            }>
          }
        : {}),
      ...(typeof body.targetPipelineId === "string" ? { targetPipelineId: body.targetPipelineId as PiPgmPipelineId } : {}),
      ...(typeof body.cueImmediately === "boolean" ? { cueImmediately: body.cueImmediately } : {})
    });
    return reply.code(201).send(item);
  });

  app.get<{ Params: { assetId: string } }>("/api/v1/pipgm/assets/:assetId", async (request, reply) => {
    const asset: PiPgmAsset | undefined = service.getAsset(request.params.assetId);
    if (asset?.stored && !asset.data && !asset.filePath) {
      // Kept in the library store (pistorage): fetched when served.
      let bytes: Buffer | null;
      try {
        bytes = await service.readStoredAsset(asset.id);
      } catch {
        return reply.code(503).send({ error: { code: "STORE_UNAVAILABLE", message: "The library store cannot be reached" } });
      }
      if (!bytes) {
        return reply.code(404).send({ error: { code: "ASSET_NOT_FOUND", message: `The file of asset ${asset.id} is gone` } });
      }
      return reply.type(asset.mimeType).header("cache-control", "no-cache").send(bytes);
    }
    if (!asset?.data && !asset?.filePath) {
      return reply.code(404).send({ error: { code: "ASSET_NOT_FOUND", message: `Unknown PiPGM asset: ${request.params.assetId}` } });
    }
    if (asset.filePath) {
      // Streamed from the disk cache, with single-range support so the browser can seek and loop.
      let size: number;
      try {
        size = (await stat(asset.filePath)).size;
      } catch {
        return reply.code(404).send({ error: { code: "ASSET_NOT_FOUND", message: `The file of asset ${asset.id} is gone` } });
      }
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ""));
      reply.type(asset.mimeType).header("cache-control", "no-cache").header("accept-ranges", "bytes");
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start >= size || start > end) {
          return reply.code(416).header("content-range", `bytes */${size}`).send();
        }
        return reply
          .code(206)
          .header("content-range", `bytes ${start}-${end}/${size}`)
          .header("content-length", end - start + 1)
          .send(createReadStream(asset.filePath, { start, end }));
      }
      return reply.header("content-length", size).send(createReadStream(asset.filePath));
    }
    return reply.type(asset.mimeType).header("cache-control", "no-cache").send(asset.data);
  });

  return app;
}

function isPipelineId(service: PiPgmService, value: unknown): value is PiPgmPipelineId {
  return typeof value === "string" && service.isValidPipelineId(value);
}
