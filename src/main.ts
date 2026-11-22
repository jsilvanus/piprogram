import { join } from "node:path";
import { LibraryPersistence, PiStorageBlobStore } from "./library-store.js";
import { buildPipgmServer } from "./server.js";
import { createEncoderSelector, type EncoderSetting } from "./encoder.js";

/** Starts the PiPGM HTTP API. Reads PIPGM_PORT (default 3200), PIPGM_HOST (default 127.0.0.1) and PIPGM_API_KEY. */
async function main(): Promise<void> {
  const port = Number(process.env.PIPGM_PORT ?? 3200);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PIPGM_PORT must be a port number");
  const host = process.env.PIPGM_HOST?.trim() || "127.0.0.1";
  const apiKey = process.env.PIPGM_API_KEY?.trim() || undefined;
  if (!apiKey && host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("PIPGM_API_KEY is required when PIPGM_HOST is not loopback");
  }
  // Prepared speech is cached on disk (PIPGM_CACHE_DIR, default ./data/cache) so it survives restarts.
  const cacheDir = process.env.PIPGM_CACHE_DIR?.trim() || join(process.cwd(), "data", "cache");
  // The feeds are published to MediaMTX from here when PIPGM_PUBLISH_RTSP_BASE is set (for example
  // rtsp://127.0.0.1:8554). Turn pimatrix's own PiPGM poll off first (PIMATRIX_PIPGM_FEED=off), or two
  // publishers fight for the same stream names.
  const rtspBase = process.env.PIPGM_PUBLISH_RTSP_BASE?.trim();
  const encoder = (process.env.PIPGM_PUBLISH_ENCODER?.trim() || "auto") as EncoderSetting;
  if (encoder !== "auto" && encoder !== "libx264" && encoder !== "h264_v4l2m2m") {
    throw new Error("PIPGM_PUBLISH_ENCODER must be auto, libx264 or h264_v4l2m2m");
  }
  const fallbackEnv = process.env.PIPGM_ENCODER_FALLBACK?.trim().toLowerCase();
  if (fallbackEnv && fallbackEnv !== "off" && fallbackEnv !== "on") throw new Error("PIPGM_ENCODER_FALLBACK must be on or off");
  const idleStopSeconds = process.env.PIPGM_FEED_IDLE_STOP_SECONDS ? Number(process.env.PIPGM_FEED_IDLE_STOP_SECONDS) : 0;
  if (!Number.isFinite(idleStopSeconds) || idleStopSeconds < 0) {
    throw new Error("PIPGM_FEED_IDLE_STOP_SECONDS must be 0 (off) or a number of seconds");
  }
  const fps = process.env.PIPGM_PUBLISH_FPS ? Number(process.env.PIPGM_PUBLISH_FPS) : undefined;
  if (fps !== undefined && (!Number.isInteger(fps) || fps < 1 || fps > 30)) {
    throw new Error("PIPGM_PUBLISH_FPS must be a whole number from 1 to 30");
  }
  // The media library is kept in pistorage when PIPGM_STORAGE_URL is set; otherwise it is memory only.
  const storageUrl = process.env.PIPGM_STORAGE_URL?.trim();
  const blobStore = storageUrl
    ? new PiStorageBlobStore({ baseUrl: storageUrl, apiKey: process.env.PIPGM_STORAGE_API_KEY?.trim() || undefined })
    : undefined;
  const libraryStore = blobStore
    ? new LibraryPersistence(blobStore, process.env.PIPGM_STORAGE_PREFIX?.trim() || "piprogram/library")
    : undefined;
  const ffmpegBin = process.env.PIPGM_FFMPEG?.trim() || undefined;
  // One probe of `ffmpeg -encoders` at start (auto, Linux only); the result is kept for the process.
  const encoderSelector = rtspBase
    ? await createEncoderSelector({ setting: encoder, ffmpeg: ffmpegBin, fallbackEnabled: fallbackEnv !== "off" })
    : undefined;
  const app = buildPipgmServer({
    ...(libraryStore ? { libraryStore } : {}),
    ...(blobStore ? { stepStore: blobStore, playlistStore: blobStore } : {}),
    apiKey,
    logger: true,
    cacheDir,
    ...(rtspBase && encoderSelector
      ? {
          publish: {
            rtspBase,
            ...(process.env.PIPGM_FFMPEG?.trim() ? { ffmpeg: process.env.PIPGM_FFMPEG.trim() } : {}),
            encoder: encoderSelector,
            idleStopSeconds,
            ...(fps ? { fps } : {})
          }
        }
      : {})
  });
  const shutdown = (): void => {
    void app.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await app.listen({ host, port });
}

main().catch((error: unknown) => {
  console.error("piprogram failed to start:", error);
  process.exitCode = 1;
});
