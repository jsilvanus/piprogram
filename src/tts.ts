/**
 * Text to speech for the PA lane. The engine is pluggable (tests inject a fake one); the default
 * runs Piper (https://github.com/rhasspy/piper), which works offline on a Pi 4 and has Finnish
 * voices. Nothing is bundled here: the binary and the voice models are installed on the Pi and
 * found through the environment (see the README).
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TtsEngine {
  /** Returns a complete WAV file. Rejects on failure. */
  synthesize(text: string, options: { voice?: string | undefined }): Promise<Buffer>;
}

/** Voice names are file names without extension; no path characters. */
export const VOICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/;

export interface WavInfo {
  durationMs: number;
  sampleRate: number;
  channels: number;
}

/** Reads the duration of a PCM WAV from its header. Returns null when the bytes are not a usable WAV. */
export function readWavInfo(buffer: Buffer): WavInfo | null {
  if (buffer.length < 44) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12;
  let byteRate = 0;
  let sampleRate = 0;
  let channels = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= buffer.length) {
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      byteRate = buffer.readUInt32LE(body + 8);
    } else if (id === "data") {
      if (byteRate <= 0 || sampleRate <= 0 || channels <= 0) return null;
      // A streamed WAV can carry 0xFFFFFFFF as the size; use what is really there.
      const available = buffer.length - body;
      const bytes = size === 0xffffffff || size > available ? available : size;
      return { durationMs: Math.round((bytes / byteRate) * 1000), sampleRate, channels };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

export interface PiperEngineConfig {
  /** Piper binary (default "piper"). */
  binary: string;
  /** Directory holding `<voice>.onnx` (and its `.onnx.json`). */
  modelDir: string;
  /** Voice used when the request names none, e.g. "fi_FI-harri-medium". */
  defaultVoice: string;
  timeoutMs: number;
}

export function createPiperEngine(config: PiperEngineConfig): TtsEngine {
  return {
    async synthesize(text, options) {
      const voice = options.voice ?? config.defaultVoice;
      if (!VOICE_NAME.test(voice)) throw new Error("invalid voice name");
      const dir = await mkdtemp(join(tmpdir(), "piprogram-tts-"));
      const out = join(dir, "speech.wav");
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(config.binary, ["--model", join(config.modelDir, `${voice}.onnx`), "--output_file", out], {
            stdio: ["pipe", "ignore", "pipe"]
          });
          let stderr = "";
          child.stderr.on("data", (chunk: Buffer) => {
            stderr = (stderr + chunk.toString()).slice(-400);
          });
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`piper timed out after ${config.timeoutMs} ms`));
          }, config.timeoutMs);
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once("close", (code) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`piper exited with ${code}: ${stderr.trim()}`));
          });
          child.stdin.on("error", () => undefined);
          child.stdin.end(text.replace(/\s+/g, " ").trim() + "\n");
        });
        return await readFile(out);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  };
}

/** Piper from the environment, or undefined when PIPGM_TTS_MODEL_DIR is not set (TTS is then off). */
export function createTtsEngineFromEnv(env: NodeJS.ProcessEnv = process.env): TtsEngine | undefined {
  const modelDir = env.PIPGM_TTS_MODEL_DIR?.trim();
  if (!modelDir) return undefined;
  const timeout = Number(env.PIPGM_TTS_TIMEOUT_MS);
  return createPiperEngine({
    binary: env.PIPGM_TTS_PIPER?.trim() || "piper",
    modelDir,
    defaultVoice: env.PIPGM_TTS_VOICE?.trim() || "fi_FI-harri-medium",
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 30_000
  });
}
