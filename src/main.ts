import { join } from "node:path";
import { LibraryPersistence, PiStorageBlobStore } from "./library-store.js";
import { buildPipgmServer } from "./server.js";
import { ffmpegAudioNormaliser } from "./audio-upload.js";
import { parseLocalAudioDevices } from "./local-audio.js";
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
  const feedInput = process.env.PIPGM_FEED_INPUT?.trim().toLowerCase() || "raw";
  if (feedInput !== "raw" && feedInput !== "png") throw new Error("PIPGM_FEED_INPUT must be raw or png");
  const fps = process.env.PIPGM_PUBLISH_FPS ? Number(process.env.PIPGM_PUBLISH_FPS) : undefined;
  if (fps !== undefined && (!Number.isInteger(fps) || fps < 1 || fps > 30)) {
    throw new Error("PIPGM_PUBLISH_FPS must be a whole number from 1 to 30");
  }
  // Sound on the published feeds (TTS and audio items): off unless PIPGM_PUBLISH_AUDIO=1, because the stream then
  // carries an AAC track and the player on the other side (pimatrix, hdmi) must accept it.
  const audioEnv = process.env.PIPGM_PUBLISH_AUDIO?.trim().toLowerCase();
  if (audioEnv && !["0", "1", "on", "off", "true", "false"].includes(audioEnv)) throw new Error("PIPGM_PUBLISH_AUDIO must be 1 or 0");
  const publishAudio = audioEnv === "1" || audioEnv === "on" || audioEnv === "true";
  // The media library is kept in pistorage when PIPGM_STORAGE_URL is set; otherwise it is memory only.
  const storageUrl = process.env.PIPGM_STORAGE_URL?.trim();
  const blobStore = storageUrl
    ? new PiStorageBlobStore({ baseUrl: storageUrl, apiKey: process.env.PIPGM_STORAGE_API_KEY?.trim() || undefined })
    : undefined;
  const libraryStore = blobStore
    ? new LibraryPersistence(blobStore, process.env.PIPGM_STORAGE_PREFIX?.trim() || "piprogram/library")
    : undefined;
  const ffmpegBin = process.env.PIPGM_FFMPEG?.trim() || undefined;
  // Publishing is switched at runtime (PUT /api/v1/pipgm/publish); PIPGM_PUBLISH_RTSP_BASE and PIPGM_PUBLISH_AUDIO only
  // seed the first start. The probe of `ffmpeg -encoders` (auto, Linux only) runs when publishing is first switched on.
  const encoderProvider = () => createEncoderSelector({ setting: encoder, ffmpeg: ffmpegBin, fallbackEnabled: fallbackEnv !== "off" });
  const localDevices = parseLocalAudioDevices(process.env.PIPGM_LOCAL_AUDIO_DEVICES);
  const app = buildPipgmServer({
    ...(libraryStore ? { libraryStore } : {}),
    ...(blobStore ? { stepStore: blobStore, playlistStore: blobStore } : {}),
    apiKey,
    logger: true,
    // Uploaded audio of any format is converted with ffmpeg (PIPGM_AUDIO_CONVERT=off keeps files as sent).
    ...(process.env.PIPGM_AUDIO_CONVERT?.trim().toLowerCase() === "off"
      ? {}
      : { audioNormaliser: ffmpegAudioNormaliser({ ffmpeg: ffmpegBin ?? "ffmpeg", ffprobe: process.env.PIPGM_FFPROBE?.trim() || "ffprobe" }) }),
    cacheDir,
    publish: {
      ...(rtspBase ? { rtspBase } : {}),
      ...(ffmpegBin ? { ffmpeg: ffmpegBin } : {}),
      encoder: encoderProvider,
      idleStopSeconds,
      feedInput,
      ...(publishAudio ? { audio: true } : {}),
      ...(fps ? { fps } : {})
    },
    localAudio: {
      devices: localDevices,
      ...(process.env.PIPGM_LOCAL_AUDIO_APLAY?.trim() ? { aplay: process.env.PIPGM_LOCAL_AUDIO_APLAY.trim() } : {})
    }
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
