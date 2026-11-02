/**
 * HTTP API for PiPGM (piprogram). The routes and their error shapes match the
 * `/api/v1/pipgm/*` routes that pimatrix served before the split, so existing
 * clients keep working. Canva routes are not here yet (they are the 1.1 step).
 *
 * Auth: when an API key is configured, every non-GET request under /api/v1/
 * needs `Authorization: Bearer <key>` or `x-api-key`. Reads stay open, as in pimatrix.
 */

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

export interface PipgmServerOptions extends PiPgmServiceOptions {
  /** Service instance; a new PiPgmService is created from the options when omitted. */
  service?: PiPgmService;
  /** API key for mutating requests. Undefined = open (development). */
  apiKey?: string | undefined;
  /** Logger passed to Fastify; false disables logging. */
  logger?: boolean;
  /** Renders the frame route. Defaults to headless Chromium (PIPGM_CHROMIUM). */
  frameRenderer?: PipgmFrameRenderer;
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
  const renderFrame = options.frameRenderer ?? createChromiumFrameRenderer();
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

  app.get<{ Params: { pipelineId: string } }>("/pipgm/:pipelineId/stage", async (request, reply) => {
    const pipeline = service.getPipeline(request.params.pipelineId);
    if (!pipeline) return notFound(reply, request.params.pipelineId);
    return reply.type("text/html; charset=utf-8").send(renderPiPgmStageHtml(pipeline));
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
    if (!asset?.data) {
      return reply.code(404).send({ error: { code: "ASSET_NOT_FOUND", message: `Unknown PiPGM asset: ${request.params.assetId}` } });
    }
    return reply.type(asset.mimeType).header("cache-control", "no-cache").send(asset.data);
  });

  return app;
}

function isPipelineId(service: PiPgmService, value: unknown): value is PiPgmPipelineId {
  return typeof value === "string" && service.isValidPipelineId(value);
}
