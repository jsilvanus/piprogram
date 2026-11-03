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
import { MAX_AUDIO_ARM_SECONDS, PiPgmService, type PiPgmServiceOptions } from "./pipgm-service.js";
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
import { StepImages, ffmpegThumbnailer, type Thumbnailer } from "./step-cache.js";
import { MemoryBlobStore, type BlobStore } from "./library-store.js";
import { PipgmFeeders, type FeederEncoder, type SpawnFeeder } from "./feeder.js";

export interface PipgmServerOptions extends PiPgmServiceOptions {
  /** How often an unloaded library or unsaved items are retried against the store (default 60 s). */
  libraryRetryMs?: number | undefined;
  /**
   * Where prepared step pictures and thumbnails are kept (pistorage in production). Without it they are
   * kept in memory and lost on restart.
   */
  stepStore?: BlobStore | undefined;
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
   * Publish the three feeds (PiPGM1-3) to MediaMTX from this process. Undefined = off.
   * Starts when the server is ready and stops when it closes.
   */
  publish?: { rtspBase: string; ffmpeg?: string; encoder?: FeederEncoder; fps?: number; spawn?: SpawnFeeder };
}

const FRAME_MIN_SIDE = 16;
const FRAME_MAX_SIDE = 3840;

type FrameQuery = { width?: string; height?: string; alpha?: string };

/** Frame size and alpha from the query string; the pipeline's own resolution is the default. */
function parseFrameQuery(
  query: FrameQuery,
  resolution: { width: number; height: number }
): { ok: true; width: number; height: number; alpha: boolean } | { ok: false; message: string } {
  const side = (value: string | undefined, fallback: number, name: string) => {
    if (value === undefined) return { ok: true as const, value: fallback };
    const parsed = /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isInteger(parsed) || parsed < FRAME_MIN_SIDE || parsed > FRAME_MAX_SIDE) {
      return { ok: false as const, message: `${name} must be a whole number from ${FRAME_MIN_SIDE} to ${FRAME_MAX_SIDE}` };
    }
    return { ok: true as const, value: parsed };
  };
  const width = side(query.width, resolution.width, "width");
  if (!width.ok) return { ok: false, message: width.message };
  const height = side(query.height, resolution.height, "height");
  if (!height.ok) return { ok: false, message: height.message };
  if (query.alpha !== undefined && !["1", "0", "true", "false"].includes(query.alpha)) {
    return { ok: false, message: "alpha must be 1, 0, true or false" };
  }
  return {
    ok: true,
    width: width.value,
    height: height.value,
    alpha: query.alpha === "1" || query.alpha === "true"
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

  app.get("/health", async () => ({ status: "ok", service: "piprogram" }));

  const steps = new StepImages({
    store: options.stepStore ?? new MemoryBlobStore(),
    renderFrame,
    snapshotForStep: (itemId, step, orientation) => service.snapshotForStep(itemId, step, orientation),
    getItem: (itemId) => service.getLibraryItem(itemId),
    thumbnailer: options.thumbnailer ?? ffmpegThumbnailer(options.publish?.ffmpeg)
  });

  const feeders = options.publish
    ? new PipgmFeeders({
        service,
        renderFrame,
        rtspBase: options.publish.rtspBase,
        ffmpeg: options.publish.ffmpeg,
        encoder: options.publish.encoder,
        fps: options.publish.fps,
        spawn: options.publish.spawn,
        steps,
        onError: (pipelineId, message) => app.log.warn({ pipelineId, err: message }, "feed publisher")
      })
    : null;
  if (feeders) {
    app.addHook("onReady", async () => feeders.start());
    app.addHook("onClose", async () => feeders.stop());
  }

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

  app.get("/api/v1/pipgm/feeders", async () => ({
    enabled: feeders !== null,
    feeds: feeders ? feeders.status() : {}
  }));

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
    Body: { orientation?: unknown; hidden?: unknown; linked?: unknown; fadeDurationMs?: unknown };
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
    const updated = service.updatePipelineConfig(request.params.pipelineId, {
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
    Body: { audioEnabled?: unknown; toggle?: unknown; volume?: unknown; armSeconds?: unknown; sync?: unknown };
  }>("/api/v1/pipgm/pipelines/:pipelineId/audio", async (request, reply) => {
    if (!service.isValidPipelineId(request.params.pipelineId)) return notFound(reply, request.params.pipelineId);
    const body = request.body ?? {};
    if (body.audioEnabled !== undefined && typeof body.audioEnabled !== "boolean") {
      return invalid(reply, "INVALID_AUDIO_VALUE", "audioEnabled must be a boolean");
    }
    const volume = body.volume !== undefined ? Number(body.volume) : undefined;
    if (volume !== undefined && (!Number.isFinite(volume) || volume < 0 || volume > 100)) {
      return invalid(reply, "INVALID_VOLUME", "volume must be between 0 and 100");
    }
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

  app.post<{ Params: { pipelineId: string }; Body: { itemId?: unknown; loop?: unknown; volume?: unknown } }>(
    "/api/v1/pipgm/pipelines/:pipelineId/audio/play",
    async (request, reply) => {
      if (!service.isValidPipelineId(request.params.pipelineId)) return notFound(reply, request.params.pipelineId);
      const body = request.body ?? {};
      const itemId = typeof body.itemId === "string" ? body.itemId.trim() : "";
      if (!itemId) return invalid(reply, "ITEM_ID_REQUIRED", "itemId is required");
      if (body.loop !== undefined && typeof body.loop !== "boolean") {
        return invalid(reply, "INVALID_LOOP", "loop must be a boolean");
      }
      const volume = body.volume !== undefined ? Number(body.volume) : undefined;
      if (volume !== undefined && (!Number.isFinite(volume) || volume < 0 || volume > 100)) {
        return invalid(reply, "INVALID_VOLUME", "volume must be between 0 and 100");
      }
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

  // Kill switch: silences every pipeline, clears the tracks and disarms. Needs the API key like any write.
  app.post("/api/v1/pipgm/audio/kill", async (_request, reply) => {
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

  // ---- Library items -------------------------------------------------------

  app.get("/api/v1/pipgm/items", async () => ({ items: service.listLibraryItems() }));

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
    let checkedDurationMs: number | undefined;
    if (body.kind === "audio") {
      const audio = Buffer.from(typeof body.dataBase64 === "string" ? body.dataBase64 : "", "base64");
      const mime = typeof body.mimeType === "string" ? body.mimeType : "";
      const checked = service.checkAudioUpload(audio, mime, filename);
      if (!checked.ok) {
        return reply.code(checked.code === "AUDIO_TOO_LARGE" ? 413 : 422).send({
          error: { code: checked.code, message: checked.message }
        });
      }
      checkedDurationMs = checked.durationMs;
    }
    const item = service.createUploadedMediaItem({
      kind: body.kind,
      filename,
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.mimeType === "string" ? { mimeType: body.mimeType } : {}),
      ...(typeof body.dataBase64 === "string" ? { dataBase64: body.dataBase64 } : {}),
      ...(body.fit === "contain" || body.fit === "cover" ? { fit: body.fit } : {}),
      ...(typeof body.caption === "string" ? { caption: body.caption } : {}),
      ...(checkedDurationMs !== undefined
        ? { durationMs: checkedDurationMs }
        : typeof body.durationMs === "number"
          ? { durationMs: body.durationMs }
          : {}),
      ...(typeof body.autoplay === "boolean" ? { autoplay: body.autoplay } : {}),
      ...(typeof body.loop === "boolean" ? { loop: body.loop } : {}),
      ...(typeof body.targetPipelineId === "string" ? { targetPipelineId: body.targetPipelineId as PiPgmPipelineId } : {}),
      ...(typeof body.cueImmediately === "boolean" ? { cueImmediately: body.cueImmediately } : {})
    });
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
