/**
 * Publishes the three PiPGM feeds (PiPGM1-3) to MediaMTX, so piprogram pushes its own
 * pictures instead of pimatrix polling for them.
 *
 * One long-running ffmpeg per pipeline reads frames from stdin (raw yuv420p, decoded once per picture; or PNG) and
 * publishes them over RTSP. A timer writes the current picture at a steady rate; a slide
 * change only swaps which picture the timer writes. The same process keeps running, so
 * the stream never drops and the HDMI player on the other side never sees a gap (the old
 * route restarted ffmpeg per slide, which left about a second of black).
 *
 * Only the picture travels here. The stream has no audio track: sound on a feed is a
 * separate concern (see README). The feed is never taken down by a fade to black or an
 * empty pipeline; it publishes a black frame instead, so a route to it stays valid.
 *
 * Disabled unless PIPGM_PUBLISH_RTSP_BASE is set. Not verified on the real Pi.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { deflateSync, crc32 } from "node:zlib";
import type { PiPgmPipelineSnapshot, PiPgmPipelineId } from "./pipgm-model.js";
import type { PiPgmService } from "./pipgm-service.js";
import type { PipgmFrameRenderer } from "./frame.js";
import { renderPiPgmStageHtml } from "./stage-html.js";

import { EncoderSelector, type FeederEncoder } from "./encoder.js";
import { AUDIO_CHANNELS, AUDIO_RATE, FeedAudio, ffmpegAudioToPcm, type AudioToPcm } from "./feed-audio.js";

export type { FeederEncoder } from "./encoder.js";

export interface FeederProcess {
  stdin: { write(chunk: Buffer): boolean; once(event: "drain", listener: () => void): unknown; end(): void } | null;
  /** Second pipe (fd 3) carrying raw PCM for the audio track; present only when the feed publishes audio. */
  audioIn?: { write(chunk: Buffer): boolean; once(event: "drain", listener: () => void): unknown; end(): void } | null;
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

/** What the feed's ffmpeg reads on stdin: PNG files (decoded by ffmpeg each time) or raw yuv420p frames. */
export type FeedInput = "raw" | "png";

/** Even size ffmpeg works at: the same `trunc(iw/2)*2` rule the PNG path applies with its scale filter. */
export function evenSize(width: number, height: number): { width: number; height: number } {
  return { width: width - (width % 2), height: height - (height % 2) };
}

/** Bytes of one raw yuv420p frame of this (even) size. */
export function rawFrameBytes(width: number, height: number): number {
  const even = evenSize(width, height);
  return (even.width * even.height * 3) / 2;
}

/**
 * The ffmpeg command line of one feed: H.264 over RTSP. Input is PNG frames on stdin, or, with `raw`, raw
 * yuv420p frames of that size (no decoding in ffmpeg). Pure.
 */
export function feederArgs(
  rtspUrl: string,
  fps: number,
  encoder: FeederEncoder,
  inputFps = fps,
  raw?: { width: number; height: number },
  audio = false
): string[] {
  const encoderArgs =
    encoder === "h264_v4l2m2m"
      ? ["-c:v", "h264_v4l2m2m", "-b:v", "2M"]
      : ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-bf", "0"];
  const even = raw ? evenSize(raw.width, raw.height) : null;
  const input = even
    ? ["-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", `${even.width}x${even.height}`, "-framerate", String(inputFps), "-i", "-"]
    : [
        "-f", "image2pipe",
        "-framerate", String(inputFps),
        "-c:v", "png",
        "-i", "-"
      ];
  // An output option: it must come after every input, or ffmpeg rejects it as an option of the audio input.
  const videoFilter = ["-vf", even ? "format=yuv420p" : "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p"];
  // With audio, a second input (raw PCM on fd 3) becomes an AAC track; without it the stream has no audio.
  const audioArgs = audio
    ? [
        "-f", "s16le", "-ar", String(AUDIO_RATE), "-ac", String(AUDIO_CHANNELS), "-thread_queue_size", "512", "-i", "pipe:3",
        "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "96k", "-ar", String(AUDIO_RATE), "-ac", String(AUDIO_CHANNELS)
      ]
    : ["-an"];
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel", "warning",
    ...input,
    ...audioArgs,
    ...videoFilter,
    ...encoderArgs,
    "-r", String(fps),
    "-g", String(fps),
    "-f", "rtsp",
    "-rtsp_transport", "tcp",
    rtspUrl
  ];
}

/** Turns a PNG into one raw yuv420p frame (even size). Rejects on any failure; the feeder then falls back to PNG. */
export type PngToRaw = (png: Buffer, width: number, height: number) => Promise<Buffer>;

/** One-shot ffmpeg conversion, run once per picture change. */
export function ffmpegPngToRaw(ffmpeg = "ffmpeg", timeoutMs = 20_000): PngToRaw {
  return (png, width, height) =>
    new Promise<Buffer>((resolve, reject) => {
      const child = nodeSpawn(
        ffmpeg,
        [
          "-hide_banner", "-nostdin", "-loglevel", "error",
          "-f", "image2pipe", "-c:v", "png", "-i", "-",
          "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
          "-frames:v", "1", "-f", "rawvideo", "-"
        ],
        { stdio: ["pipe", "pipe", "pipe"] }
      );
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", (c: Buffer) => out.push(c));
      child.stderr.on("data", (c: Buffer) => err.push(c));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const raw = Buffer.concat(out);
        if (code !== 0) reject(new Error(`ffmpeg exited with code ${code}: ${Buffer.concat(err).toString("utf8").slice(0, 200)}`));
        else if (raw.length !== rawFrameBytes(width, height)) reject(new Error(`raw frame is ${raw.length} bytes, expected ${rawFrameBytes(width, height)}`));
        else resolve(raw);
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(png);
    });
}

export interface StillFeederOptions {
  rtspUrl: string;
  /** Publish an audio track: the feeder writes this source's PCM (silence when idle) to ffmpeg's second pipe. */
  audio?: FeedAudio | undefined;
  ffmpeg?: string | undefined;
  /** A fixed encoder, or a function read at every (re)launch so a fallback takes effect. */
  encoder?: FeederEncoder | (() => FeederEncoder) | undefined;
  /** Called when a h264_v4l2m2m ffmpeg exits within `earlyExitMs` of its start. */
  onEarlyExit?: ((reason: string) => void) | undefined;
  /** Default 3000 ms. */
  earlyExitMs?: number | undefined;
  fps?: number | undefined;
  /** Input pipe framerate (frames written per second). Default 1 so ffmpeg duplicates frames to `fps`. */
  inputFps?: number | undefined;
  /** `raw` (default): decode each picture once and feed raw yuv420p; `png`: feed the PNG every tick (old behaviour). */
  input?: FeedInput | undefined;
  /** Converter used in raw mode; default is a one-shot ffmpeg. */
  convert?: PngToRaw | undefined;
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
  /** What is written each tick: the PNG, or its raw yuv420p decode. */
  private frame: Buffer | null = null;
  private frameKind: FeedInput = "png";
  private frameWidth = 0;
  private frameHeight = 0;
  /** The picture most recently passed to show(); a conversion that finishes late for an older one is dropped. */
  private requested: Buffer | null = null;
  private width: number | null = null;
  private height: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private draining = false;
  private audioTimer: ReturnType<typeof setInterval> | null = null;
  private audioDraining = false;
  private audioStartedAt = 0;
  private audioFrames = 0;
  private stopped = true;
  private restarts = 0;
  private failuresInARow = 0;
  private lastError: string | null = null;
  private readonly fps: number;
  private readonly inputFps: number;
  private readonly spawn: SpawnFeeder;
  private readonly input: FeedInput;
  private readonly convert: PngToRaw;

  constructor(private readonly options: StillFeederOptions) {
    this.fps = options.fps ?? 5;
    this.inputFps = options.inputFps ?? Math.min(this.fps, 1);
    this.input = options.input ?? "raw";
    this.convert = options.convert ?? ffmpegPngToRaw(options.ffmpeg);
    this.spawn =
      options.spawn ??
      ((command, args) => {
        const withAudio = args.includes("pipe:3");
        const child = nodeSpawn(command, [...args], {
          stdio: withAudio ? ["pipe", "ignore", "ignore", "pipe"] : ["pipe", "ignore", "ignore"]
        });
        return {
          stdin: child.stdin,
          audioIn: withAudio ? (child.stdio[3] as unknown as FeederProcess["audioIn"]) : null,
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

  /**
   * Show this picture from now on. A new size restarts ffmpeg (one process cannot change size). In raw mode the
   * PNG is decoded once here; until that is done the previous picture keeps being written. If the conversion
   * fails the PNG itself is fed for this picture (ffmpeg decodes it, a restart switches the input type).
   */
  show(png: Buffer, width: number, height: number): void {
    this.requested = png;
    this.width = width;
    this.height = height;
    this.stopped = false;
    if (this.input === "png") {
      this.apply(png, "png", width, height);
    } else {
      this.convert(png, width, height).then(
        (raw) => {
          if (this.requested === png && !this.stopped) this.apply(raw, "raw", width, height);
        },
        (error: unknown) => {
          if (this.requested !== png || this.stopped) return;
          this.options.onError?.(`raw conversion failed, feeding the PNG for this picture: ${error instanceof Error ? error.message : String(error)}`);
          this.apply(png, "png", width, height);
        }
      );
    }
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), Math.round(1000 / this.inputFps));
      this.timer.unref();
    }
  }

  private apply(frame: Buffer, kind: FeedInput, width: number, height: number): void {
    const changedFormat = this.process !== null && (this.frameKind !== kind || this.frameWidth !== width || this.frameHeight !== height);
    const frameChanged = this.frame !== frame;
    this.frame = frame;
    this.frameKind = kind;
    this.frameWidth = width;
    this.frameHeight = height;
    if (changedFormat) this.killProcess();
    if (!this.process && !this.restartTimer) this.launch();
    else if (frameChanged && this.process) this.tick();
  }

  /** Relaunch ffmpeg now (new encoder after a fallback). No effect while stopped or without a picture. */
  restartProcess(): void {
    if (this.stopped || !this.frame) return;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.failuresInARow = 0;
    this.killProcess();
    this.launch();
  }

  stop(): void {
    this.stopped = true;
    this.requested = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.killProcess();
  }

  /** Writes audio frames to ffmpeg's second pipe at the wall-clock rate (silence when the source has none). */
  private audioTick(): void {
    const audio = this.options.audio;
    const pipe = this.process?.audioIn;
    if (!audio || !pipe || this.audioDraining) return;
    const due = Math.floor(((Date.now() - this.audioStartedAt) / 1000) * AUDIO_RATE) - this.audioFrames;
    // After a stall do not burst more than a second; the lost time is simply silence.
    const frames = Math.min(due, AUDIO_RATE);
    if (due > AUDIO_RATE) this.audioFrames += due - AUDIO_RATE;
    if (frames <= 0) return;
    this.audioFrames += frames;
    try {
      if (!pipe.write(audio.pull(frames))) {
        this.audioDraining = true;
        pipe.once("drain", () => {
          this.audioDraining = false;
        });
      }
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private startAudioTimer(): void {
    this.stopAudioTimer();
    if (!this.options.audio) return;
    this.audioStartedAt = Date.now();
    this.audioFrames = 0;
    this.audioDraining = false;
    this.audioTimer = setInterval(() => this.audioTick(), 100);
    this.audioTimer.unref();
  }

  private stopAudioTimer(): void {
    if (this.audioTimer) clearInterval(this.audioTimer);
    this.audioTimer = null;
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
    const configured = this.options.encoder;
    const encoder: FeederEncoder = (typeof configured === "function" ? configured() : configured) ?? "libx264";
    const proc = this.spawn(
      this.options.ffmpeg ?? "ffmpeg",
      feederArgs(
        this.options.rtspUrl,
        this.fps,
        encoder,
        this.inputFps,
        this.frameKind === "raw" ? { width: this.frameWidth, height: this.frameHeight } : undefined,
        this.options.audio !== undefined
      )
    );
    this.process = proc;
    this.draining = false;
    this.startAudioTimer();
    (proc.audioIn as unknown as { on?(event: "error", listener: () => void): void } | null | undefined)?.on?.("error", () => undefined);
    const startedAt = Date.now();
    const ended = (reason: string) => {
      // A process that was replaced or stopped on purpose is not a failure.
      if (this.process !== proc) return;
      this.process = null;
      this.draining = false;
      this.stopAudioTimer();
      if (Date.now() - startedAt >= 10_000) this.failuresInARow = 0;
      this.fail(reason);
    };
    proc.onExit((code) => {
      const current = this.process === proc;
      const early = Date.now() - startedAt < (this.options.earlyExitMs ?? 3000);
      const reason = `ffmpeg exited with ${code ?? "a signal"}`;
      ended(reason);
      if (current && early && encoder === "h264_v4l2m2m") this.options.onEarlyExit?.(reason);
    });
    proc.onError((error) => ended(error.message));
    proc.stdin?.once("drain", () => undefined);
    (proc.stdin as unknown as { on?(event: "error", listener: () => void): void } | null)?.on?.("error", () => undefined);
    if (this.frame) this.tick();
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
    this.stopAudioTimer();
    if (!proc) return;
    try {
      proc.audioIn?.end();
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
  /** Fixed encoder (no fallback) or a selector that can fall back to libx264. Default libx264. */
  encoder?: FeederEncoder | EncoderSelector | undefined;
  /** Seconds a pipeline may have no slide before its feeder is stopped; 0/undefined = never. */
  idleStopSeconds?: number | undefined;
  /** Least time between two feeds starting their ffmpeg; 0 or unset = start at once. The server sets 1500 ms: starting all three at once made the hardware encoder fail. */
  startGapMs?: number | undefined;
  /** Called once when the hardware encoder failed early and the feeders switched to libx264. */
  onFallback?: ((message: string) => void) | undefined;
  fps?: number | undefined;
  /** `raw` (default) decodes each picture once and feeds raw frames; `png` feeds PNGs (old behaviour). */
  feedInput?: FeedInput | undefined;
  /** Test hook: replaces the one-shot ffmpeg PNG-to-raw conversion. */
  convert?: PngToRaw | undefined;
  /**
   * Publish sound with the picture: every feed gets an AAC track that is silent until an audio track is played on
   * it (and the feed is armed). `load` returns the bytes of an audio library item; `toPcm` decodes them (default
   * one-shot ffmpeg). Without this option the streams have no audio track.
   */
  audio?: { load(itemId: string): Promise<Buffer | null>; toPcm?: AudioToPcm | undefined } | undefined;
  /** Which feeds publish (default all three). Change later with `setActive`. */
  feeds?: PiPgmPipelineId[] | undefined;
  /** How often the pipelines are looked at for a change, default 250 ms. */
  intervalMs?: number | undefined;
  spawn?: SpawnFeeder | undefined;
  /** Prepared step pictures: read when there is one, kept after a render when there is not. */
  steps?: { lookup(snapshot: PiPgmPipelineSnapshot): Promise<Buffer | null>; remember(snapshot: PiPgmPipelineSnapshot, png: Buffer): Promise<void> } | undefined;
  onError?: ((pipelineId: PiPgmPipelineId, message: string) => void) | undefined;
}

const FEED_IDS: PiPgmPipelineId[] = ["PiPGM1", "PiPGM2", "PiPGM3"];
/** The Pi's V4L2 H.264 encoder takes two encodes at once; a third feed starts on libx264. */
const HARDWARE_FEEDS = 2;

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

/**
 * True when the pipeline has something to show or is armed: an active item, a basic image, or a loaded
 * playlist (the pre-warm signal: a loaded playlist means a slide is about to be queued).
 */
export function hasContent(snapshot: PiPgmPipelineSnapshot): boolean {
  return snapshot.activeItemId !== null || snapshot.basicImageItemId !== null || snapshot.playlist.length > 0;
}

export type FeederState = "running" | "idle-stopped" | "stopped" | "off";
export type PipgmFeederStatus = StillFeederStatus & { state: FeederState };

/** Follows the three pipelines in this process and keeps their feeds up to date. */
export class PipgmFeeders {
  private readonly feeders = new Map<PiPgmPipelineId, StillFeeder>();
  private readonly shown = new Map<PiPgmPipelineId, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly idleSince = new Map<PiPgmPipelineId, number>();
  private readonly idleStopped = new Set<PiPgmPipelineId>();
  private readonly selector: EncoderSelector;
  private readonly sound = new Map<PiPgmPipelineId, FeedAudio>();
  private readonly loading = new Map<PiPgmPipelineId, string>();
  private readonly toPcm: AudioToPcm | undefined;
  /** Feeds that are published. Others are left alone: no ffmpeg, no stream. Default all three. */
  private active: Set<PiPgmPipelineId>;
  private lastStartAt = 0;
  /** Feeds holding one of the hardware encoder slots. Released when the feed is stopped on purpose. */
  private readonly hardwareFeeds = new Set<PiPgmPipelineId>();
  /** Early h264_v4l2m2m failures per feed; the first one is retried on the hardware encoder. */
  private readonly earlyFailures = new Map<PiPgmPipelineId, number>();
  /** Feeds that fell back to libx264 for good. */
  private readonly softwareFeeds = new Set<PiPgmPipelineId>();

  constructor(private readonly options: PipgmFeedersOptions) {
    this.active = new Set(options.feeds ?? FEED_IDS);
    this.toPcm = options.audio ? (options.audio.toPcm ?? ffmpegAudioToPcm(options.ffmpeg)) : undefined;
    const enc = options.encoder;
    this.selector = enc instanceof EncoderSelector ? enc : EncoderSelector.fixed(enc ?? "libx264");
    for (const id of FEED_IDS) {
      if (options.audio) this.sound.set(id, new FeedAudio());
      this.feeders.set(
        id,
        new StillFeeder({
          audio: this.sound.get(id),
          rtspUrl: `${options.rtspBase.replace(/\/$/, "")}/${id}`,
          ffmpeg: options.ffmpeg,
          encoder: () => this.encoderFor(id),
          onEarlyExit: (reason) => this.feedEncoderFailed(id, reason),
          fps: options.fps,
          input: options.feedInput,
          convert: options.convert,
          spawn: options.spawn,
          onError: (message) => options.onError?.(id, message)
        })
      );
    }
  }

  status(): Record<string, PipgmFeederStatus> {
    return Object.fromEntries(
      FEED_IDS.map((id) => {
        const status = this.feeders.get(id)!.status();
        const state: FeederState = !this.active.has(id) ? "off" : this.idleStopped.has(id) ? "idle-stopped" : status.running ? "running" : "stopped";
        return [id, { ...status, state }];
      })
    );
  }

  /** The encoder in use and whether a feed fell back to libx264. */
  encoderInfo(): { encoder: FeederEncoder; fallback: boolean; idleStopSeconds: number } {
    return {
      encoder: this.selector.current,
      fallback: this.softwareFeeds.size > 0,
      idleStopSeconds: this.options.idleStopSeconds ?? 0
    };
  }

  /** The encoder a feed starts with: hardware while it holds one of the two slots, libx264 otherwise. */
  private encoderFor(id: PiPgmPipelineId): FeederEncoder {
    if (this.selector.current === "libx264" || !this.selector.canFallBack) return this.selector.current;
    if (this.softwareFeeds.has(id)) return "libx264";
    if (this.hardwareFeeds.has(id)) return "h264_v4l2m2m";
    if (this.hardwareFeeds.size >= HARDWARE_FEEDS) return "libx264";
    this.hardwareFeeds.add(id);
    return "h264_v4l2m2m";
  }

  /** One early exit of a feed's hardware encoder: retried once, then this feed alone uses libx264. */
  private feedEncoderFailed(id: PiPgmPipelineId, reason: string): void {
    if (!this.selector.canFallBack) return;
    const failures = (this.earlyFailures.get(id) ?? 0) + 1;
    this.earlyFailures.set(id, failures);
    if (failures < 2) return;
    this.softwareFeeds.add(id);
    this.hardwareFeeds.delete(id);
    this.options.onFallback?.(`${id}: h264_v4l2m2m failed twice within its first seconds (${reason}); this feed uses libx264`);
    this.feeders.get(id)!.restartProcess();
  }

  /** Publishes exactly these feeds. A feed that is switched off stops its ffmpeg at once; the others are not touched. */
  setActive(ids: string[]): void {
    const next = new Set(FEED_IDS.filter((id) => ids.includes(id)));
    for (const id of FEED_IDS) {
      if (this.active.has(id) && !next.has(id)) {
        this.feeders.get(id)!.stop();
        this.hardwareFeeds.delete(id);
        this.shown.delete(id);
        this.idleSince.delete(id);
        this.idleStopped.delete(id);
        this.loading.delete(id);
      }
    }
    this.active = next;
    if (this.timer) void this.tick();
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
    this.loading.clear();
    this.shown.clear();
    this.idleSince.clear();
    this.idleStopped.clear();
  }

  /** One pass over the pipelines. Overlapping passes are skipped (a render can take a while). */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const id of FEED_IDS) if (this.active.has(id)) await this.follow(id);
    } finally {
      this.running = false;
    }
  }

  /**
   * Keeps the feed's sound source in step with the pipeline: the armed track plays (decoded once, when its play id
   * is new), anything else is silence. Returns true while a track is wanted, so an idle feed stays up for it.
   */
  private syncAudio(id: PiPgmPipelineId, snapshot: PiPgmPipelineSnapshot): boolean {
    const sound = this.sound.get(id);
    if (!sound || !this.options.audio || !this.toPcm) return false;
    const track = snapshot.audioEnabled ? snapshot.audioTrack : null;
    sound.setVolume(snapshot.effectiveVolume / 100);
    if (!track) {
      this.loading.delete(id);
      if (sound.playKey !== null) sound.stop();
      return false;
    }
    if (sound.playKey !== track.playId && this.loading.get(id) !== track.playId) {
      this.loading.set(id, track.playId);
      const { load } = this.options.audio;
      const toPcm = this.toPcm;
      void (async () => {
        try {
          const bytes = await load(track.itemId);
          if (!bytes) throw new Error(`audio item ${track.itemId} has no file`);
          const pcm = await toPcm(bytes);
          if (this.loading.get(id) !== track.playId) return; // stopped or replaced while decoding
          sound.play(pcm, { key: track.playId, loop: track.loop });
        } catch (error) {
          this.options.onError?.(id, `audio: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          if (this.loading.get(id) === track.playId) this.loading.delete(id);
        }
      })();
    }
    return true;
  }

  private async follow(id: PiPgmPipelineId): Promise<void> {
    const snapshot = this.options.service.getPipeline(id);
    if (!snapshot) return;
    const soundActive = this.syncAudio(id, snapshot);
    const idleMs = (this.options.idleStopSeconds ?? 0) * 1000;
    if (idleMs > 0) {
      if (hasContent(snapshot) || soundActive) {
        this.idleSince.delete(id);
        if (this.idleStopped.delete(id)) this.shown.delete(id); // a slide (or armed playlist): start again at once
      } else if (this.idleStopped.has(id)) {
        return;
      } else {
        const since = this.idleSince.get(id) ?? Date.now();
        this.idleSince.set(id, since);
        if (this.shown.has(id) && Date.now() - since >= idleMs) {
          this.feeders.get(id)!.stop();
          this.hardwareFeeds.delete(id);
          this.idleStopped.add(id);
          this.shown.delete(id);
          return;
        }
      }
    }
    const key = pictureKey(snapshot);
    if (this.shown.get(id) === key) return;
    // A feed that is not running starts its ffmpeg only when the previous start is long enough ago; the next pass tries again.
    const feeder = this.feeders.get(id)!;
    const wasRunning = feeder.status().running;
    if (!wasRunning && Date.now() - this.lastStartAt < (this.options.startGapMs ?? 0)) return;
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
      feeder.show(png, width, height);
      if (!wasRunning) this.lastStartAt = Date.now();
      this.shown.set(id, key);
    } catch (error) {
      // Not recorded as shown: the next pass tries again. The feed keeps its last picture.
      this.options.onError?.(id, error instanceof Error ? error.message : String(error));
    }
  }
}
