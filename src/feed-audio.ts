/**
 * The sound of one published feed. The feed's ffmpeg gets a continuous PCM stream (48 kHz, stereo, 16-bit)
 * on a second pipe: silence while nothing plays, the armed audio track when one does. That keeps one
 * steady audio track in the RTSP stream, so the player on the other side never sees it appear or vanish.
 *
 * `FeedAudio` is pure (no timers, no I/O): the feeder asks it for the next N frames. Gain is the
 * feed's effective volume (already capped by the service); a new track fades in, a stopped one fades out.
 */
import { spawn as nodeSpawn } from "node:child_process";

export const AUDIO_RATE = 48_000;
export const AUDIO_CHANNELS = 2;
/** Bytes of one frame (one sample for each channel), s16le. */
export const AUDIO_FRAME_BYTES = AUDIO_CHANNELS * 2;

export interface FeedAudioOptions {
  /** Fade-in of a new track, default 1500 ms (the same as the stage page). */
  fadeInMs?: number | undefined;
  /** Fade-out when a track is stopped, default 150 ms. */
  fadeOutMs?: number | undefined;
}

export class FeedAudio {
  private pcm: Buffer | null = null;
  private position = 0; // frames
  private loop = false;
  private key: string | null = null;
  private volume = 0;
  private fadeInFrames: number;
  private fadeOutFrames: number;
  private played = 0; // frames since this track started
  private stopping = false;
  private fadeOutLeft = 0;
  private finished = false;

  constructor(options: FeedAudioOptions = {}) {
    this.fadeInFrames = Math.round(((options.fadeInMs ?? 1500) / 1000) * AUDIO_RATE);
    this.fadeOutFrames = Math.max(1, Math.round(((options.fadeOutMs ?? 150) / 1000) * AUDIO_RATE));
  }

  /** The play id of the track now loaded (even while it fades out is null), or null. */
  get playKey(): string | null {
    return this.stopping ? null : this.key;
  }

  /** True while the track plays or fades out (it makes sound). A finished non-looping track is not playing. */
  get playing(): boolean {
    return this.pcm !== null && !this.finished;
  }

  /** Start a track from PCM bytes (s16le, 48 kHz, stereo). Replaces whatever played. */
  play(pcm: Buffer, options: { key: string; loop: boolean }): void {
    const usable = pcm.length - (pcm.length % AUDIO_FRAME_BYTES);
    this.pcm = usable > 0 ? pcm.subarray(0, usable) : null;
    this.position = 0;
    this.loop = options.loop;
    this.key = options.key;
    this.played = 0;
    this.stopping = false;
    this.fadeOutLeft = 0;
    this.finished = this.pcm === null;
  }

  /** Fade the track out and drop it. */
  stop(): void {
    if (!this.pcm || this.finished) {
      this.clear();
      return;
    }
    if (this.stopping) return;
    this.stopping = true;
    this.fadeOutLeft = this.fadeOutFrames;
  }

  /** Volume 0..1 (the feed's effective volume / 100). */
  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
  }

  private clear(): void {
    this.pcm = null;
    this.key = null;
    this.position = 0;
    this.stopping = false;
    this.fadeOutLeft = 0;
    this.finished = false;
  }

  /** The next `frames` frames: silence when nothing plays. */
  pull(frames: number): Buffer {
    const out = Buffer.alloc(frames * AUDIO_FRAME_BYTES);
    if (!this.pcm || this.finished) return out;
    const pcm = this.pcm;
    const total = pcm.length / AUDIO_FRAME_BYTES;
    for (let i = 0; i < frames; i += 1) {
      if (this.position >= total) {
        if (this.loop) this.position = 0;
        else {
          this.finished = true;
          break;
        }
      }
      let gain = this.volume;
      if (this.fadeInFrames > 0 && this.played < this.fadeInFrames) gain *= this.played / this.fadeInFrames;
      if (this.stopping) {
        gain *= this.fadeOutLeft / this.fadeOutFrames;
        this.fadeOutLeft -= 1;
      }
      const src = this.position * AUDIO_FRAME_BYTES;
      const dst = i * AUDIO_FRAME_BYTES;
      for (let c = 0; c < AUDIO_CHANNELS; c += 1) {
        const sample = Math.round(pcm.readInt16LE(src + c * 2) * gain);
        out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), dst + c * 2);
      }
      this.position += 1;
      this.played += 1;
      if (this.stopping && this.fadeOutLeft <= 0) {
        this.clear();
        break;
      }
    }
    return out;
  }
}

/** Decodes any audio file (WAV from Piper, mp3, ...) to s16le 48 kHz stereo. Rejects on failure or when too long. */
export type AudioToPcm = (audio: Buffer) => Promise<Buffer>;

/** One-shot ffmpeg decode. `maxSeconds` caps the decoded length (default 300 s); a longer file is refused. */
export function ffmpegAudioToPcm(ffmpeg = "ffmpeg", maxSeconds = 300, timeoutMs = 60_000): AudioToPcm {
  const maxBytes = maxSeconds * AUDIO_RATE * AUDIO_FRAME_BYTES;
  return (audio) =>
    new Promise<Buffer>((resolve, reject) => {
      const child = nodeSpawn(
        ffmpeg,
        ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", "-", "-vn", "-f", "s16le", "-ar", String(AUDIO_RATE), "-ac", String(AUDIO_CHANNELS), "-"],
        { stdio: ["pipe", "pipe", "pipe"] }
      );
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      let tooLong = false;
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          tooLong = true;
          child.kill("SIGKILL");
        } else out.push(c);
      });
      child.stderr.on("data", (c: Buffer) => err.push(c));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (tooLong) reject(new Error(`audio is longer than ${maxSeconds} s`));
        else if (code !== 0) reject(new Error(`ffmpeg exited with code ${code}: ${Buffer.concat(err).toString("utf8").slice(0, 200)}`));
        else resolve(Buffer.concat(out));
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(audio);
    });
}
