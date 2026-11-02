import { join } from "node:path";
import { buildPipgmServer } from "./server.js";
import type { FeederEncoder } from "./feeder.js";

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
  const encoder = process.env.PIPGM_PUBLISH_ENCODER?.trim();
  if (encoder && encoder !== "libx264" && encoder !== "h264_v4l2m2m") {
    throw new Error("PIPGM_PUBLISH_ENCODER must be libx264 or h264_v4l2m2m");
  }
  const fps = process.env.PIPGM_PUBLISH_FPS ? Number(process.env.PIPGM_PUBLISH_FPS) : undefined;
  if (fps !== undefined && (!Number.isInteger(fps) || fps < 1 || fps > 30)) {
    throw new Error("PIPGM_PUBLISH_FPS must be a whole number from 1 to 30");
  }
  const app = buildPipgmServer({
    apiKey,
    logger: true,
    cacheDir,
    ...(rtspBase
      ? {
          publish: {
            rtspBase,
            ...(process.env.PIPGM_FFMPEG?.trim() ? { ffmpeg: process.env.PIPGM_FFMPEG.trim() } : {}),
            ...(encoder ? { encoder: encoder as FeederEncoder } : {}),
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
