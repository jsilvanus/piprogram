/**
 * Which H.264 encoder the feeders use. PIPGM_PUBLISH_ENCODER=auto (default) takes the Pi hardware encoder
 * (h264_v4l2m2m) on Linux when `ffmpeg -encoders` lists it, otherwise libx264. A hardware encoder that
 * dies within its first seconds is replaced by libx264 for the rest of the process (see EncoderSelector).
 * Not verified on the real Pi.
 */

import { execFile } from "node:child_process";

export type FeederEncoder = "libx264" | "h264_v4l2m2m";
export type EncoderSetting = "auto" | FeederEncoder;

/** Runs a command and returns its stdout; rejects on failure. Injectable for tests. */
export type RunCommand = (command: string, args: readonly string[]) => Promise<string>;

const defaultRun: RunCommand = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout))
    );
  });

/** One cheap probe: does this ffmpeg list h264_v4l2m2m? False on any failure. */
export async function probeV4l2m2m(ffmpeg = "ffmpeg", run: RunCommand = defaultRun): Promise<boolean> {
  try {
    const out = await run(ffmpeg, ["-hide_banner", "-encoders"]);
    return /\bh264_v4l2m2m\b/.test(out);
  } catch {
    return false;
  }
}

export interface EncoderSelectorOptions {
  setting: EncoderSetting;
  /** Result of the probe; only used for `auto`. */
  v4l2m2mAvailable?: boolean;
  /** PIPGM_ENCODER_FALLBACK=off sets this to false. Default true. */
  fallbackEnabled?: boolean;
}

/** Holds the encoder in use and remembers a fallback for the lifetime of the process. */
export class EncoderSelector {
  private encoder: FeederEncoder;
  private fellBack = false;
  private earlyFailures = 0;
  private readonly fallbackEnabled: boolean;

  constructor(options: EncoderSelectorOptions) {
    this.fallbackEnabled = options.fallbackEnabled ?? true;
    this.encoder =
      options.setting === "auto" ? (options.v4l2m2mAvailable ? "h264_v4l2m2m" : "libx264") : options.setting;
  }

  /** A selector that never changes (explicit encoder, no fallback). */
  static fixed(encoder: FeederEncoder): EncoderSelector {
    return new EncoderSelector({ setting: encoder, fallbackEnabled: false });
  }

  get current(): FeederEncoder {
    return this.encoder;
  }

  get fallenBack(): boolean {
    return this.fellBack;
  }

  /**
   * A hardware-encoder ffmpeg died right after start. The first early failure only means the feeder starts
   * again on the hardware encoder; the second one switches the process to libx264. Returns true exactly once,
   * when this call switched (the caller restarts the feeders and warns); false when nothing changed.
   */
  noteEarlyFailure(): boolean {
    if (!this.fallbackEnabled || this.encoder !== "h264_v4l2m2m") return false;
    this.earlyFailures += 1;
    if (this.earlyFailures < 2) return false;
    this.encoder = "libx264";
    this.fellBack = true;
    return true;
  }
}

export interface CreateEncoderSelectorOptions {
  setting: EncoderSetting;
  ffmpeg?: string | undefined;
  fallbackEnabled?: boolean | undefined;
  platform?: NodeJS.Platform | undefined;
  run?: RunCommand | undefined;
}

/** Resolves the setting; probes ffmpeg once, and only for `auto` on Linux. */
export async function createEncoderSelector(options: CreateEncoderSelectorOptions): Promise<EncoderSelector> {
  const platform = options.platform ?? process.platform;
  const v4l2m2mAvailable =
    options.setting === "auto" && platform === "linux" ? await probeV4l2m2m(options.ffmpeg, options.run) : false;
  return new EncoderSelector({
    setting: options.setting,
    v4l2m2mAvailable,
    ...(options.fallbackEnabled !== undefined ? { fallbackEnabled: options.fallbackEnabled } : {})
  });
}
