/**
 * Runtime control of PiPGM publishing: whether the three feeds are published to MediaMTX, where, and whether
 * they carry sound. The operator changes it with PUT /api/v1/pipgm/publish (through pigateway); it is kept in
 * `publish-settings.json` in the cache directory and survives a restart. The env (PIPGM_PUBLISH_RTSP_BASE,
 * PIPGM_PUBLISH_AUDIO) only seeds the first start, when nothing has been stored. Off by default.
 */
import { RuntimeSettingsFile } from "./runtime-settings.js";

export interface PublishConfig {
  enabled: boolean;
  rtspBase: string | null;
  /** Feeds carry an AAC track (silent until a track is played on an armed feed). */
  audio: boolean;
}

export interface RunningFeeders {
  start(): void;
  stop(): void;
  status(): Record<string, unknown>;
  encoderInfo(): Record<string, unknown>;
}

export interface PublishControllerOptions {
  cacheDir?: string | undefined;
  /** Used only when no setting has been stored yet. */
  defaults?: { rtspBase?: string | undefined; audio?: boolean | undefined } | undefined;
  create: (config: { rtspBase: string; audio: boolean }) => Promise<RunningFeeders>;
  onError?: ((message: string) => void) | undefined;
}

/** rtsp://host[:port][/path], letters, digits and . - _ / only. */
export const RTSP_BASE = /^rtsp:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._/-]*)?$/;

export type PublishPatchResult = { ok: true; config: PublishConfig } | { ok: false; code: string; message: string };

export class PublishController {
  private config: PublishConfig;
  private source: "stored" | "env" | "default";
  private feeders: RunningFeeders | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly file: RuntimeSettingsFile<PublishConfig>;

  constructor(private readonly options: PublishControllerOptions) {
    this.file = new RuntimeSettingsFile<PublishConfig>(options.cacheDir, "publish-settings.json");
    const stored = this.file.read();
    const envBase = options.defaults?.rtspBase?.trim() || null;
    if (stored && typeof stored.enabled === "boolean") {
      this.source = "stored";
      this.config = {
        enabled: stored.enabled,
        rtspBase: typeof stored.rtspBase === "string" && RTSP_BASE.test(stored.rtspBase) ? stored.rtspBase : envBase,
        audio: stored.audio === true
      };
    } else if (envBase && RTSP_BASE.test(envBase)) {
      this.source = "env";
      this.config = { enabled: true, rtspBase: envBase, audio: options.defaults?.audio === true };
    } else {
      this.source = "default";
      this.config = { enabled: false, rtspBase: null, audio: false };
    }
    if (this.config.enabled && !this.config.rtspBase) this.config.enabled = false;
  }

  snapshot(): PublishConfig & { source: string; running: boolean } {
    return { ...this.config, source: this.source, running: this.feeders !== null };
  }

  /** The running feeders (null while publishing is off). */
  get current(): RunningFeeders | null {
    return this.feeders;
  }

  /** Starts publishing when the configuration says so. Called once the server is ready. */
  async start(): Promise<void> {
    await this.serialize(() => this.reconcile());
  }

  async stop(): Promise<void> {
    await this.serialize(async () => this.halt());
  }

  /** Applies a change: validates, stores it, and starts, restarts or stops the feeders. */
  async apply(patch: { enabled?: unknown; rtspBase?: unknown; audio?: unknown }): Promise<PublishPatchResult> {
    return this.serialize(async () => {
      if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") return { ok: false, code: "INVALID_ENABLED", message: "enabled must be a boolean" } as const;
      if (patch.audio !== undefined && typeof patch.audio !== "boolean") return { ok: false, code: "INVALID_AUDIO", message: "audio must be a boolean" } as const;
      let rtspBase = this.config.rtspBase;
      if (patch.rtspBase !== undefined) {
        if (typeof patch.rtspBase !== "string" || !RTSP_BASE.test(patch.rtspBase.trim())) {
          return { ok: false, code: "INVALID_RTSP_BASE", message: "rtspBase must look like rtsp://127.0.0.1:8554" } as const;
        }
        rtspBase = patch.rtspBase.trim().replace(/\/+$/, "");
      }
      const next: PublishConfig = {
        enabled: patch.enabled ?? this.config.enabled,
        rtspBase,
        audio: patch.audio ?? this.config.audio
      };
      if (next.enabled && !next.rtspBase) {
        return { ok: false, code: "RTSP_BASE_REQUIRED", message: "give rtspBase (for example rtsp://127.0.0.1:8554) to enable publishing" } as const;
      }
      const changed = next.enabled !== this.config.enabled || next.rtspBase !== this.config.rtspBase || next.audio !== this.config.audio;
      this.config = next;
      this.source = "stored";
      this.file.write(next);
      if (changed || (next.enabled && !this.feeders)) await this.reconcile(true);
      return { ok: true, config: { ...this.config } } as const;
    });
  }

  private halt(): void {
    if (!this.feeders) return;
    this.feeders.stop();
    this.feeders = null;
  }

  private async reconcile(restart = false): Promise<void> {
    if (restart) this.halt();
    if (!this.config.enabled || !this.config.rtspBase) {
      this.halt();
      return;
    }
    if (this.feeders) return;
    try {
      const feeders = await this.options.create({ rtspBase: this.config.rtspBase, audio: this.config.audio });
      feeders.start();
      this.feeders = feeders;
    } catch (error) {
      this.options.onError?.(`publishing did not start: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }
}
