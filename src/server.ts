/**
 * HTTP API for PiPGM (piprogram). The routes and their error shapes match the
 * `/api/v1/pipgm/*` routes that pimatrix served before the split, so existing
 * clients keep working. Canva routes are not here yet (they are the 1.1 step).
 *
 * Auth: when an API key is configured, every non-GET request under /api/v1/
 * needs `Authorization: Bearer <key>` or `x-api-key`. Reads stay open, as in pimatrix.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { PiPgmService, type PiPgmServiceOptions } from "./pipgm-service.js";
import type {
  PiPgmAsset,
  PiPgmControlAction,
  PiPgmOrientation,
  PiPgmPipelineId,
  PptxAnimationEffect
} from "./pipgm-model.js";
import { renderPiPgmStageHtml } from "./stage-html.js";

export interface PipgmServerOptions extends PiPgmServiceOptions {
  /** Service instance; a new PiPgmService is created from the options when omitted. */
  service?: PiPgmService;
  /** API key for mutating requests. Undefined = open (development). */
  apiKey?: string | undefined;
  /** Logger passed to Fastify; false disables logging. */
  logger?: boolean;
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
  const service = options.service ?? new PiPgmService(options);
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
    Body: { audioEnabled?: unknown; toggle?: unknown; volume?: unknown; sync?: unknown };
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
    const updated = service.setAudio(request.params.pipelineId, {
      ...(typeof body.audioEnabled === "boolean" ? { audioEnabled: body.audioEnabled } : {}),
      ...(typeof body.toggle === "boolean" ? { toggle: body.toggle } : {}),
      ...(volume !== undefined ? { volume } : {}),
      ...(typeof body.sync === "boolean" ? { sync: body.sync } : {})
    });
    return reply.code(200).send(updated);
  });

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
    if (body.kind !== "video" && body.kind !== "image") {
      return invalid(reply, "INVALID_MEDIA_KIND", "kind must be 'video' or 'image'");
    }
    const filename = typeof body.filename === "string" ? body.filename.trim() : "";
    if (!filename) return invalid(reply, "FILENAME_REQUIRED", "filename is required");
    if (body.targetPipelineId !== undefined && !isPipelineId(service, body.targetPipelineId)) {
      return invalid(reply, "INVALID_PIPELINE_ID", "targetPipelineId must be PiPGM1, PiPGM2, or PiPGM3");
    }
    const item = service.createUploadedMediaItem({
      kind: body.kind,
      filename,
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.mimeType === "string" ? { mimeType: body.mimeType } : {}),
      ...(typeof body.dataBase64 === "string" ? { dataBase64: body.dataBase64 } : {}),
      ...(body.fit === "contain" || body.fit === "cover" ? { fit: body.fit } : {}),
      ...(typeof body.caption === "string" ? { caption: body.caption } : {}),
      ...(typeof body.durationMs === "number" ? { durationMs: body.durationMs } : {}),
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
