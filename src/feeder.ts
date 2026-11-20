/**
 * Publishes the three PiPGM feeds (PiPGM1-3) to MediaMTX, so piprogram pushes its own
 * pictures instead of pimatrix polling for them.
 *
 * One long-running ffmpeg per pipeline reads PNG frames from stdin (`image2pipe`) and
 * publishes them over RTSP. A timer writes the current picture at a steady rate; a slide
 * change only swaps which picture the timer writes. The same process keeps running, so
 * the stream never drops and the HDMI player on the other side never sees a gap (the old
 * route restarted ffmpeg per slide, which left about a second of black).
 *
 * Every feed also carries an audio track (PIPGM_PUBLISH_AUDIO, default on): raw 48 kHz stereo
 * PCM written to ffmpeg's fd 3 in real time. It is silence, except while the feed's audio is
 * armed and a clip is playing; then the clip's samples are written instead. The track is always
 * there so a clip can start without restarting ffmpeg (a restart is a second of black). The
 * feed is never taken down by a fade to black or an empty pipeline; it publishes a black frame
 * instead, so a route to it stays valid.
 *
 * Disabled unless PIPGM_PUBLISH_RTSP_BASE is set. Not verified on the real Pi.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { deflateSync, crc32 } from "node:zlib";
import type { PiPgmPipelineSnapshot, PiPgmPipelineId } from "./pipgm-model.js";
import type { PiPgmService } from "./pipgm-service.js";
import type { PipgmFrameRenderer } from "./frame.js";
import { renderPiPgmStageHtml } from "./stage-html.js";

export type FeederEncoder = "libx264" | "h264_v4l2m2m";

export interface FeederProcess {
  /** ffmpeg's fd 3: raw s16le 48 kHz stereo audio. Absent when the process was started without audio. */
  audio?: { write(chunk: Buffer): boolean; once(event: "drain", listener: () => void): unknown } | null;
  stdin: { write(chunk: Buffer): boolean; once(event: "drain", listener: () => void): unknown; end(): void } | null;
  kill(signal?: NodeJS.Signals): boolean;
  onExit(listener: (code: number | null) => void): void;
  onError(listener: (error: Error) => void): void;
}

export type SpawnFeeder = (command: string, args: readonly string[]) => FeederProcess;

/** A solid-colour PNG, built by hand so no image library is needed. */
export function solidPng(width: number, height: number, rgb: [number, number, number] = [0, 0, 0]): Buffer {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y += 1) row.copy(raw, y * row.length);
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

export const AUDIO_RATE = 48000;
/** Bytes of audio per millisecond: 48 kHz, 2 channels, 16 bit. */
const AUDIO_BYTES_PER_MS = (AUDIO_RATE * 4) / 1000;

/** The ffmpeg command line of one feed: PNG frames on stdin, H.264 over RTSP, audio from fd 3 when `audio`. Pure. */
export function feederArgs(rtspUrl: string, fps: number, encoder: FeederEncoder, audio = false): string[] {
  const encoderArgs =
    encoder === "h264_v4l2m2m"
      ? ["-c:v", "h264_v4l2m2m", "-b:v", "2M"]
      : ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-bf", "0"];
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel", "warning",
    "-f", "image2pipe",
    "-framerate", String(fps),
    "-c:v", "png",
    "-i", "-",
    ...(audio
      ? ["-f", "s16le", "-ar", String(AUDIO_RATE), "-ac", "2", "-i", "pipe:3", "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "64k"]
      : ["-an"]),
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
    ...encoderArgs,
    "-r", String(fps),
    "-g", String(fps),
    "-f", "rtsp",
    "-rtsp_transport", "tcp",
    rtspUrl
  ];
}

export interface StillFeederOptions {
  rtspUrl: string;
  ffmpeg?: string | undefined;
  encoder?: FeederEncoder | undefined;
  fps?: number | undefined;
  /** Publish an audio track (silence unless a clip plays). Default false here, true for PipgmFeeders. */
  audio?: boolean | undefined;
  /** First restart delay, doubled up to maxRestartMs. Default 1000 ms. */
  restartBaseMs?: number | undefined;
  maxRestartMs?: number | undefined;
  spawn?: SpawnFeeder | undefined;
  onError?: ((message: string) => void) | undefined;
}

export interface StillFeederStatus {
  running: boolean;
  width: number | null;
  height: number | null;
  restarts: number;
  lastError: string | null;
}

/** One feed: a long-running ffmpeg plus a timer that writes the current picture to it. */
export class StillFeeder {
  private process: FeederProcess | null = null;
  private frame: Buffer | null = null;
  private width: number | null = null;
  private height: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private draining = false;
  private stopped = true;
  private restarts = 0;
  private failuresInARow = 0;
  private lastError: string | null = null;
  private readonly fps: number;
  private readonly spawn: SpawnFeeder;
  private audioTimer: ReturnType<typeof setInterval> | null = null;
  private audioStartedAt = 0;
  private audioSent = 0;
  private audioDraining = false;
  private clip: Buffer | null = null;
  private clipPos = 0;
  private clipLoop = false;
  private gain = 1;

  constructor(private readonly options: StillFeederOptions) {
    this.fps = options.fps ?? 5;
    this.spawn =
      options.spawn ??
      ((command, args) => {
        const child = nodeSpawn(command, [...args], { stdio: ["pipe", "ignore", "ignore", "pipe"] });
        child.stdio[3]?.on("error", () => undefined);
        return {
          stdin: child.stdin,
          audio: (child.stdio[3] as unknown as FeederProcess["audio"]) ?? null,
          kill: (signal) => child.kill(signal),
          onExit: (listener) => void child.once("exit", listener),
          onError: (listener) => void child.once("error", listener)
        };
      });
  }

  status(): StillFeederStatus {
    return {
      running: this.process !== null,
      width: this.width,
      height: this.height,
      restarts: this.restarts,
      lastError: this.lastError
    };
  }

  /** Show this picture from now on. A new size restarts ffmpeg (one process cannot change size). */
  show(png: Buffer, width: number, height: number): void {
    const sizeChanged = this.width !== null && (this.width !== width || this.height !== height);
    this.frame = png;
    this.width = width;
    this.height = height;
    this.stopped = false;
    if (sizeChanged && this.process) this.killProcess();
    if (!this.process && !this.restartTimer) this.launch();
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), Math.round(1000 / this.fps));
      this.timer.unref();
    }
    if (this.options.audio && !this.audioTimer) {
      this.audioTimer = setInterval(() => this.pumpAudio(), 20);
      this.audioTimer.unref();
    }
  }

  /** Play 48 kHz stereo s16le samples on the audio track from now on, replacing any clip that is playing. */
  playClip(pcm: Buffer, loop = false): void {
    this.clip = pcm.length >= 4 ? pcm : null;
    this.clipPos = 0;
    this.clipLoop = loop;
  }

  /** Back to silence. */
  stopClip(): void {
    this.clip = null;
    this.clipPos = 0;
  }

  /** 0 to 1, applied to the clip's samples. */
  setGain(gain: number): void {
    this.gain = Math.max(0, Math.min(1, gain));
  }

  isPlayingClip(): boolean {
    return this.clip !== null;
  }

  /** Writes the audio that is due by the wall clock, so the track keeps real time whatever the timer does. */
  private pumpAudio(): void {
    const sink = this.process?.audio;
    if (!sink) return;
    const due = Math.floor(((Date.now() - this.audioStartedAt) * AUDIO_BYTES_PER_MS) / 4) * 4;
    if (this.audioDraining) {
      this.audioSent = due; // a backed-up pipe drops audio instead of building a burst
      return;
    }
    while (this.audioSent < due) {
      const size = Math.min(due - this.audioSent, 7680);
      const chunk = this.nextAudio(size);
      this.audioSent += size;
      try {
        if (!sink.write(chunk)) {
          this.audioDraining = true;
          sink.once("drain", () => {
            this.audioDraining = false;
          });
          return;
        }
      } catch (error) {
        this.fail(error instanceof Error ? error.message : String(error));
        return;
      }
    }
  }

  /** `size` bytes of audio: the clip (with gain) while there is one, silence otherwise. */
  private nextAudio(size: number): Buffer {
    const out = Buffer.alloc(size);
    let at = 0;
    while (this.clip && at < size) {
      if (this.clipPos >= this.clip.length) {
        if (!this.clipLoop) {
          this.clip = null;
          break;
        }
        this.clipPos = 0;
      }
      const n = Math.min(size - at, this.clip.length - this.clipPos) & ~3;
      if (n <= 0) {
        this.clip = null;
        break;
      }
      for (let i = 0; i < n; i += 2) {
        const sample = Math.round(this.clip.readInt16LE(this.clipPos + i) * this.gain);
        out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), at + i);
      }
      this.clipPos += n;
      at += n;
    }
    return out;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.audioTimer) clearInterval(this.audioTimer);
    this.audioTimer = null;
    this.clip = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.killProcess();
  }

  private tick(): void {
    const stdin = this.process?.stdin;
    if (!stdin || !this.frame || this.draining) return;
    try {
      if (!stdin.write(this.frame)) {
        this.draining = true;
        stdin.once("drain", () => {
          this.draining = false;
        });
      }
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private launch(): void {
    const proc = this.spawn(
      this.options.ffmpeg ?? "ffmpeg",
      feederArgs(this.options.rtspUrl, this.fps, this.options.encoder ?? "libx264", this.options.audio === true)
    );
    this.process = proc;
    this.draining = false;
    this.audioDraining = false;
    this.audioStartedAt = Date.now();
    this.audioSent = 0;
    const startedAt = Date.now();
    const ended = (reason: string) => {
      // A process that was replaced or stopped on purpose is not a failure.
      if (this.process !== proc) return;
      this.process = null;
      this.draining = false;
      if (Date.now() - startedAt >= 10_000) this.failuresInARow = 0;
      this.fail(reason);
    };
    proc.onExit((code) => ended(`ffmpeg exited with ${code ?? "a signal"}`));
    proc.onError((error) => ended(error.message));
    proc.stdin?.once("drain", () => undefined);
    (proc.stdin as unknown as { on?(event: "error", listener: () => void): void } | null)?.on?.("error", () => undefined);
  }

  private fail(reason: string): void {
    this.lastError = reason;
    this.options.onError?.(reason);
    if (this.process) this.killProcess();
    if (this.stopped || this.restartTimer) return;
    this.failuresInARow += 1;
    this.restarts += 1;
    const base = this.options.restartBaseMs ?? 1000;
    const delay = Math.min(base * 2 ** (this.failuresInARow - 1), this.options.maxRestartMs ?? 30_000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped && !this.process) this.launch();
    }, delay);
    this.restartTimer.unref();
  }

  private killProcess(): void {
    const proc = this.process;
    this.process = null;
    this.draining = false;
    if (!proc) return;
    try {
      proc.stdin?.end();
    } catch {
      // already closed
    }
    proc.kill("SIGTERM");
  }
}

export interface PipgmFeedersOptions {
  service: PiPgmService;
  renderFrame: PipgmFrameRenderer;
  /** e.g. rtsp://127.0.0.1:8554 ; the stream of PiPGM1 is <base>/PiPGM1. */
  rtspBase: string;
  ffmpeg?: string | undefined;
  encoder?: FeederEncoder | undefined;
  fps?: number | undefined;
  /** Publish an audio track on every feed, default true (PIPGM_PUBLISH_AUDIO=0 turns it off). */
  audio?: boolean | undefined;
  /** The samples of a playing audio item as 48 kHz stereo s16le, or null when they cannot be read. */
  audioPcm?: ((snapshot: PiPgmPipelineSnapshot) => Promise<Buffer | null>) | undefined;
  /** How often the pipelines are looked at for a change, default 250 ms. */
  intervalMs?: number | undefined;
  spawn?: SpawnFeeder | undefined;
  /** Prepared step pictures: read when there is one, kept after a render when there is not. */
  steps?: { lookup(snapshot: PiPgmPipelineSnapshot): Promise<Buffer | null>; remember(snapshot: PiPgmPipelineSnapshot, png: Buffer): Promise<void> } | undefined;
  onError?: ((pipelineId: PiPgmPipelineId, message: string) => void) | undefined;
}

const FEED_IDS: PiPgmPipelineId[] = ["PiPGM1", "PiPGM2", "PiPGM3"];

/** What changes the picture of a pipeline. Anything else (volume, playlist edits) does not. */
export function pictureKey(snapshot: PiPgmPipelineSnapshot): string {
  return [
    snapshot.activeItemId ?? "",
    snapshot.currentStep,
    snapshot.fadeToBlack ? "ftb" : "",
    snapshot.keyColor ?? "",
    snapshot.basicImageItemId ?? "",
    snapshot.resolution.width,
    snapshot.resolution.height
  ].join("|");
}

/** Follows the three pipelines in this process and keeps their feeds up to date. */
export class PipgmFeeders {
  private readonly feeders = new Map<PiPgmPipelineId, StillFeeder>();
  private readonly shown = new Map<PiPgmPipelineId, string>();
  private readonly heard = new Map<PiPgmPipelineId, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly options: PipgmFeedersOptions) {
    for (const id of FEED_IDS) {
      this.feeders.set(
        id,
        new StillFeeder({
          rtspUrl: `${options.rtspBase.replace(/\/$/, "")}/${id}`,
          ffmpeg: options.ffmpeg,
          encoder: options.encoder,
          fps: options.fps,
          audio: options.audio ?? true,
          spawn: options.spawn,
          onError: (message) => options.onError?.(id, message)
        })
      );
    }
  }

  status(): Record<string, StillFeederStatus> {
    return Object.fromEntries(FEED_IDS.map((id) => [id, this.feeders.get(id)!.status()]));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 250);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const feeder of this.feeders.values()) feeder.stop();
    this.shown.clear();
    this.heard.clear();
  }

  /** One pass over the pipelines. Overlapping passes are skipped (a render can take a while). */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const id of FEED_IDS) await this.follow(id);
    } finally {
      this.running = false;
    }
  }

  /** Starts or stops the clip of a feed when its audio track, arming or volume changes. */
  private async followAudio(id: PiPgmPipelineId, snapshot: PiPgmPipelineSnapshot): Promise<void> {
    const feeder = this.feeders.get(id)!;
    feeder.setGain(snapshot.effectiveVolume / 100);
    const track = snapshot.audioEnabled ? snapshot.audioTrack : null;
    const key = track?.playId ?? "";
    if (this.heard.get(id) === key) return;
    this.heard.set(id, key);
    if (!track) {
      feeder.stopClip();
      return;
    }
    try {
      const pcm = await this.options.audioPcm?.(snapshot);
      // Stopped or replaced while the samples were being read: leave the newer state alone.
      if (this.heard.get(id) !== key) return;
      if (pcm) feeder.playClip(pcm, track.loop);
      else this.options.onError?.(id, `audio ${track.itemId} could not be read`);
    } catch (error) {
      this.options.onError?.(id, error instanceof Error ? error.message : String(error));
    }
  }

  private async follow(id: PiPgmPipelineId): Promise<void> {
    const snapshot = this.options.service.getPipeline(id);
    if (!snapshot) return;
    await this.followAudio(id, snapshot);
    const key = pictureKey(snapshot);
    if (this.shown.get(id) === key) return;
    const { width, height } = snapshot.resolution;
    try {
      let png: Buffer;
      if (snapshot.fadeToBlack) {
        png = solidPng(width, height);
      } else {
        // Prepared pictures carry the normal stage background; a keyed feed renders its own.
        const prepared = snapshot.keyColor ? null : await this.options.steps?.lookup(snapshot);
        if (prepared) {
          png = prepared;
        } else {
          png = await this.options.renderFrame({
            html: renderPiPgmStageHtml(snapshot, { transparent: false, silent: true, keyColor: snapshot.keyColor }),
            width,
            height,
            transparent: false
          });
          if (!snapshot.keyColor) void this.options.steps?.remember(snapshot, png);
        }
      }
      this.feeders.get(id)!.show(png, width, height);
      this.shown.set(id, key);
    } catch (error) {
      // Not recorded as shown: the next pass tries again. The feed keeps its last picture.
      this.options.onError?.(id, error instanceof Error ? error.message : String(error));
    }
  }
}

/** Decodes any audio file ffmpeg reads to 48 kHz stereo s16le, the format of a feed's audio track. */
export function decodeToPcm(
  ffmpeg: string,
  input: Buffer,
  spawn: (command: string, args: string[]) => { stdin: { end(data: Buffer): void } | null; stdout: NodeJS.ReadableStream | null; once(event: "error" | "close", listener: (arg?: unknown) => void): unknown } = (command, args) =>
    nodeSpawn(command, args, { stdio: ["pipe", "pipe", "ignore"] })
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ar", String(AUDIO_RATE), "-ac", "2", "pipe:1"]);
    const parts: Buffer[] = [];
    child.stdout?.on("data", (part: Buffer) => parts.push(part));
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code === 0 && parts.length > 0 ? Buffer.concat(parts) : null));
    (child.stdin as unknown as { on?(event: "error", listener: () => void): void } | null)?.on?.("error", () => undefined);
    child.stdin?.end(input);
  });
}
