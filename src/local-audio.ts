/**
 * Direct sound for spoken announcements: plays an audio item (for example prepared TTS) on one of the Pi's
 * HDMI sound cards with `aplay`, with no stream and no video encode in between. Which HDMI output is the one
 * whose sound reaches the PA is NOT decided here: pigateway works it out from the Atlona route and tells us
 * (`SoundOutputState`); piprogram only maps an output name (hdmi0 / hdmi1) to an ALSA device from its env.
 *
 * Off until switched on at runtime (PUT /api/v1/pipgm/local-audio; PIPGM_LOCAL_AUDIO_DEVICES only seeds the
 * first start). One phrase plays at a time. The kill switch stops it. Nothing here plays by itself: a request
 * has to ask.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { AUDIO_CHANNELS, AUDIO_FRAME_BYTES, AUDIO_RATE, type AudioToPcm } from "./feed-audio.js";

export const SOUND_OUTPUTS = ["hdmi0", "hdmi1"] as const;
export type SoundOutput = (typeof SOUND_OUTPUTS)[number];

export function isSoundOutput(value: unknown): value is SoundOutput {
  return typeof value === "string" && (SOUND_OUTPUTS as readonly string[]).includes(value);
}

/** ALSA device names: letters, digits and `. _ : , = / -` only. */
export const ALSA_DEVICE = /^[A-Za-z0-9._:,=/-]+$/;

/** Parses `hdmi0=hdmi:CARD=vc4hdmi0,hdmi1=hdmi:CARD=vc4hdmi1`. Throws on a bad name or device. */
export function parseLocalAudioDevices(text: string | undefined): Partial<Record<SoundOutput, string>> {
  const devices: Partial<Record<SoundOutput, string>> = {};
  if (!text || !text.trim()) return devices;
  // A device name itself contains `=` (CARD=...), so split each entry on the first `=` only.
  for (const part of text.split(/,(?=hdmi[01]=)/)) {
    const index = part.indexOf("=");
    const name = part.slice(0, index).trim();
    const device = part.slice(index + 1).trim();
    if (!isSoundOutput(name)) throw new Error(`PIPGM_LOCAL_AUDIO_DEVICES: unknown output "${name}" (use ${SOUND_OUTPUTS.join(", ")})`);
    if (!device || !ALSA_DEVICE.test(device)) throw new Error(`PIPGM_LOCAL_AUDIO_DEVICES: ${name} needs an ALSA device name (letters, digits and . _ : , = / -)`);
    devices[name] = device;
  }
  return devices;
}

/** Scales s16le PCM by `gain` (0..1), with a short linear fade-in and fade-out against clicks. Pure. */
export function applyGain(pcm: Buffer, gain: number, fadeMs = 30): Buffer {
  const frames = Math.floor(pcm.length / AUDIO_FRAME_BYTES);
  const out = Buffer.alloc(frames * AUDIO_FRAME_BYTES);
  const fade = Math.max(1, Math.round((fadeMs / 1000) * AUDIO_RATE));
  const g = Math.max(0, Math.min(1, gain));
  for (let i = 0; i < frames; i += 1) {
    const edge = Math.min(1, (i + 1) / fade, (frames - i) / fade);
    const scale = g * edge;
    for (let c = 0; c < AUDIO_CHANNELS; c += 1) {
      const at = i * AUDIO_FRAME_BYTES + c * 2;
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(at) * scale))), at);
    }
  }
  return out;
}

export interface LocalPlayerProcess {
  stdin: { write(chunk: Buffer): unknown; end(): void } | null;
  kill(signal?: NodeJS.Signals): boolean;
  onExit(listener: (code: number | null) => void): void;
  onError(listener: (error: Error) => void): void;
}
export type SpawnLocalPlayer = (command: string, args: readonly string[]) => LocalPlayerProcess;

export interface LocalAudioOptions {
  /** Starting configuration; changed at runtime with `configure`. */
  enabled?: boolean | undefined;
  devices?: Partial<Record<SoundOutput, string>> | undefined;
  /** Player binary, default `aplay` (PIPGM_LOCAL_AUDIO_APLAY). */
  aplay?: string | undefined;
  toPcm: AudioToPcm;
  spawn?: SpawnLocalPlayer | undefined;
}

export interface LocalPlayStatus {
  playing: boolean;
  output: SoundOutput | null;
  itemId: string | null;
  startedAt: string | null;
}

export type LocalPlayResult =
  | { ok: true; output: SoundOutput; device: string; volume: number; dryRun: boolean }
  | { ok: false; code: "LOCAL_AUDIO_NOT_CONFIGURED" | "NO_DEVICE_FOR_OUTPUT" | "BAD_AUDIO" | "PLAYER_FAILED"; message: string };

const defaultSpawn: SpawnLocalPlayer = (command, args) => {
  const child = nodeSpawn(command, [...args], { stdio: ["pipe", "ignore", "pipe"] });
  return {
    stdin: child.stdin,
    kill: (signal) => child.kill(signal),
    onExit: (listener) => void child.once("exit", listener),
    onError: (listener) => void child.once("error", listener)
  };
};

export class LocalAudio {
  private current: { proc: LocalPlayerProcess; output: SoundOutput; itemId: string; startedAt: string } | null = null;
  private readonly spawnPlayer: SpawnLocalPlayer;
  private enabled: boolean;
  private devices: Partial<Record<SoundOutput, string>>;

  constructor(private readonly options: LocalAudioOptions) {
    this.spawnPlayer = options.spawn ?? defaultSpawn;
    this.enabled = options.enabled ?? false;
    this.devices = { ...(options.devices ?? {}) };
  }

  /** True when switched on and at least one output has a device. */
  get configured(): boolean {
    return this.enabled && Object.keys(this.devices).length > 0;
  }

  /** The runtime configuration (what PUT /local-audio sets). Turning it off stops a phrase that is playing. */
  config(): { enabled: boolean; devices: Partial<Record<SoundOutput, string>> } {
    return { enabled: this.enabled, devices: { ...this.devices } };
  }

  configure(next: { enabled?: boolean | undefined; devices?: Partial<Record<SoundOutput, string | null>> | undefined }): void {
    if (next.devices) {
      for (const [name, device] of Object.entries(next.devices) as Array<[SoundOutput, string | null]>) {
        if (device === null) delete this.devices[name];
        else this.devices[name] = device;
      }
    }
    if (next.enabled !== undefined) this.enabled = next.enabled;
    if (!this.configured) this.stop();
  }

  status(): LocalPlayStatus {
    return {
      playing: this.current !== null,
      output: this.current?.output ?? null,
      itemId: this.current?.itemId ?? null,
      startedAt: this.current?.startedAt ?? null
    };
  }

  /**
   * Plays `audio` (any format ffmpeg reads) on `output` at `volume` (0-100, already capped by the caller).
   * A phrase that is playing is stopped first. With `dryRun` nothing is decoded or played.
   */
  async play(input: { audio: Buffer; output: SoundOutput; volume: number; itemId: string; dryRun?: boolean }): Promise<LocalPlayResult> {
    if (!this.configured) return { ok: false, code: "LOCAL_AUDIO_NOT_CONFIGURED", message: "local audio is off or has no device (PUT /api/v1/pipgm/local-audio)" };
    const device = this.devices[input.output];
    if (!device) return { ok: false, code: "NO_DEVICE_FOR_OUTPUT", message: `no ALSA device is configured for ${input.output}` };
    const volume = Math.max(0, Math.min(100, input.volume));
    if (input.dryRun) return { ok: true, output: input.output, device, volume, dryRun: true };
    let pcm: Buffer;
    try {
      pcm = applyGain(await this.options.toPcm(input.audio), volume / 100);
    } catch (error) {
      return { ok: false, code: "BAD_AUDIO", message: error instanceof Error ? error.message : String(error) };
    }
    this.stop();
    let proc: LocalPlayerProcess;
    try {
      proc = this.spawnPlayer(this.options.aplay ?? "aplay", ["-q", "-t", "raw", "-f", "S16_LE", "-r", String(AUDIO_RATE), "-c", String(AUDIO_CHANNELS), "-D", device]);
    } catch (error) {
      return { ok: false, code: "PLAYER_FAILED", message: error instanceof Error ? error.message : String(error) };
    }
    const entry = { proc, output: input.output, itemId: input.itemId, startedAt: new Date().toISOString() };
    this.current = entry;
    const done = () => {
      if (this.current === entry) this.current = null;
    };
    proc.onExit(done);
    proc.onError(done);
    (proc.stdin as unknown as { on?(event: "error", listener: () => void): void } | null)?.on?.("error", () => undefined);
    proc.stdin?.write(pcm);
    proc.stdin?.end();
    return { ok: true, output: input.output, device, volume, dryRun: false };
  }

  /** Stops the phrase now (kill switch, a new phrase, shutdown). */
  stop(): void {
    const entry = this.current;
    this.current = null;
    if (!entry) return;
    try {
      entry.proc.stdin?.end();
    } catch {
      // already closed
    }
    entry.proc.kill("SIGTERM");
  }
}

/**
 * Which Pi HDMI output currently carries the sound that reaches the PA, as pigateway last reported it.
 * A report older than `maxAgeMs` counts as unknown: a gateway that has stopped telling us must not leave us
 * playing into a route that has since changed.
 */
export class SoundOutputState {
  private output: SoundOutput | null = null;
  private updatedAt = 0;
  private source = "";

  constructor(private readonly maxAgeMs: number, private readonly now: () => number = Date.now) {}

  set(output: SoundOutput | null, source: string): void {
    this.output = output;
    this.updatedAt = this.now();
    this.source = source;
  }

  /** The reported output, or null when none was reported or the report is stale. */
  current(): SoundOutput | null {
    if (this.updatedAt === 0 || this.now() - this.updatedAt > this.maxAgeMs) return null;
    return this.output;
  }

  snapshot(): { output: SoundOutput | null; reported: SoundOutput | null; stale: boolean; updatedAt: string | null; source: string | null; maxAgeSeconds: number } {
    const stale = this.updatedAt === 0 || this.now() - this.updatedAt > this.maxAgeMs;
    return {
      output: this.current(),
      reported: this.output,
      stale,
      updatedAt: this.updatedAt ? new Date(this.updatedAt).toISOString() : null,
      source: this.source || null,
      maxAgeSeconds: Math.round(this.maxAgeMs / 1000)
    };
  }
}
