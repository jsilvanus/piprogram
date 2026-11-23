/**
 * Uploads in any audio format. Whatever the browser or a phone produced (wav, mp3, m4a, ogg, flac, webm from a
 * recording) is decoded by ffmpeg and stored as one format every browser plays: a 48 kHz stereo mp3. A PCM WAV that
 * passes its header check is kept as it is (prepared speech is WAV too). The length comes from ffprobe on the result.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface NormalisedAudio {
  data: Buffer;
  mimeType: string;
  /** File extension without a dot, to name the stored file. */
  extension: string;
  durationMs: number;
}

/** Converts an uploaded audio file. Rejects with an AudioUploadError when ffmpeg cannot read it or it is too long. */
export type AudioNormaliser = (audio: Buffer, options: { maxSeconds: number }) => Promise<NormalisedAudio>;

export class AudioUploadError extends Error {
  constructor(
    readonly code: "AUDIO_UNREADABLE" | "AUDIO_TOO_LONG" | "AUDIO_CONVERT_FAILED",
    message: string
  ) {
    super(message);
    this.name = "AudioUploadError";
  }
}

function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c: Buffer) => (stdout = (stdout + c.toString()).slice(-4000)));
    child.stderr.on("data", (c: Buffer) => (stderr = (stderr + c.toString()).slice(-800)));
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export function ffmpegAudioNormaliser(config: { ffmpeg?: string; ffprobe?: string; timeoutMs?: number } = {}): AudioNormaliser {
  const ffmpeg = config.ffmpeg ?? "ffmpeg";
  const ffprobe = config.ffprobe ?? "ffprobe";
  const timeoutMs = config.timeoutMs ?? 60_000;
  return async (audio, { maxSeconds }) => {
    const dir = await mkdtemp(join(tmpdir(), "piprogram-audio-"));
    try {
      const input = join(dir, "in");
      const output = join(dir, "out.mp3");
      await writeFile(input, audio);
      // -t one second past the limit: a longer file is cut there and then refused by the duration check below.
      const converted = await run(
        ffmpeg,
        ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", input, "-vn", "-map_metadata", "-1", "-t", String(maxSeconds + 1), "-ar", "48000", "-ac", "2", "-codec:a", "libmp3lame", "-q:a", "3", output],
        timeoutMs
      );
      if (converted.code !== 0) {
        throw new AudioUploadError("AUDIO_UNREADABLE", `ffmpeg could not read the file: ${converted.stderr.trim().slice(0, 200)}`);
      }
      const probed = await run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", output], 15_000);
      const seconds = Number(probed.stdout.trim());
      if (probed.code !== 0 || !Number.isFinite(seconds) || seconds <= 0) {
        throw new AudioUploadError("AUDIO_CONVERT_FAILED", "the converted file has no usable length");
      }
      if (seconds > maxSeconds) throw new AudioUploadError("AUDIO_TOO_LONG", `audio can be at most ${maxSeconds} seconds`);
      return { data: await readFile(output), mimeType: "audio/mpeg", extension: "mp3", durationMs: Math.round(seconds * 1000) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
