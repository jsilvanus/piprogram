/**
 * Runtime control of PiPGM publishing: whether the three feeds are published to MediaMTX, where, and whether
 * they carry sound. The operator changes it with PUT /api/v1/pipgm/publish (through pigateway); it is kept in
 * `publish-settings.json` in the cache directory and survives a restart. The env (PIPGM_PUBLISH_RTSP_BASE,
 * PIPGM_PUBLISH_AUDIO) only seeds the first start, when nothing has been stored. Off by default.
 */
import { RuntimeSettingsFile } from "./runtime-settings.js";

export const FEED_IDS = ["PiPGM1", "PiPGM2", "PiPGM3"] as const;
export type FeedId = (typeof FEED_IDS)[number];

export interface PublishConfig {
  /** True while at least one feed is published. `PUT {enabled}` switches all three at once. */
  enabled: boolean;
  /** Each feed is published on its own. All off by default. */
  feeds: Record<FeedId, boolean>;
  rtspBase: string | null;
  /** Feeds carry an AAC track (silent until a track is played on an armed feed). */
  audio: boolean;
}

export interface RunningFeeders {
  start(): void;
  stop(): void;
  /** Publish exactly these feeds without touching the others. */
  setActive?(ids: string[]): void;
  status(): Record<string, unknown>;
  encoderInfo(): Record<string, unknown>;
}

export interface PublishControllerOptions {
  cacheDir?: string | undefined;
  /** Used only when no setting has been stored yet. */
  defaults?: { rtspBase?: string | undefined; audio?: boolean | undefined } | undefined;
  create: (config: { rtspBase: string; audio: boolean; feeds: FeedId[] }) => Promise<RunningFeeders>;
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
      const feeds = readFeeds(stored.feeds, stored.enabled);
      this.config = {
        enabled: FEED_IDS.some((id) => feeds[id]),
        feeds,
        rtspBase: typeof stored.rtspBase === "string" && RTSP_BASE.test(stored.rtspBase) ? stored.rtspBase : envBase,
        audio: stored.audio === true
      };
    } else if (envBase && RTSP_BASE.test(envBase)) {
      this.source = "env";
      this.config = { enabled: true, feeds: allFeeds(true), rtspBase: envBase, audio: options.defaults?.audio === true };
    } else {
      this.source = "default";
      this.config = { enabled: false, feeds: allFeeds(false), rtspBase: null, audio: false };
    }
    if (!this.config.rtspBase) {
      this.config.feeds = allFeeds(false);
      this.config.enabled = false;
    }
  }

  snapshot(): PublishConfig & { source: string; running: boolean } {
    return { ...this.config, feeds: { ...this.config.feeds }, source: this.source, running: this.feeders !== null };
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
  async apply(patch: { enabled?: unknown; feeds?: unknown; rtspBase?: unknown; audio?: unknown }): Promise<PublishPatchResult> {
    return this.serialize(async () => {
      if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") return { ok: false, code: "INVALID_ENABLED", message: "enabled must be a boolean" } as const;
      if (patch.audio !== undefined && typeof patch.audio !== "boolean") return { ok: false, code: "INVALID_AUDIO", message: "audio must be a boolean" } as const;
      let feeds = { ...this.config.feeds };
      if (patch.feeds !== undefined) {
        const f = patch.feeds as Record<string, unknown> | null;
        if (!f || typeof f !== "object" || Array.isArray(f)) return { ok: false, code: "INVALID_FEEDS", message: "feeds must be an object like {\"PiPGM2\": true}" } as const;
        for (const [key, value] of Object.entries(f)) {
          if (!(FEED_IDS as readonly string[]).includes(key)) return { ok: false, code: "INVALID_FEEDS", message: `unknown feed ${key}; use ${FEED_IDS.join(", ")}` } as const;
          if (typeof value !== "boolean") return { ok: false, code: "INVALID_FEEDS", message: `feeds.${key} must be a boolean` } as const;
        }
      }
      let rtspBase = this.config.rtspBase;
      if (patch.rtspBase !== undefined) {
        if (typeof patch.rtspBase !== "string" || !RTSP_BASE.test(patch.rtspBase.trim())) {
          return { ok: false, code: "INVALID_RTSP_BASE", message: "rtspBase must look like rtsp://127.0.0.1:8554" } as const;
        }
        rtspBase = patch.rtspBase.trim().replace(/\/+$/, "");
      }
      // `enabled` is the all-feeds switch; `feeds` then adjusts single feeds.
      if (typeof patch.enabled === "boolean") feeds = allFeeds(patch.enabled);
      if (patch.feeds !== undefined) Object.assign(feeds, patch.feeds as Record<string, boolean>);
      const next: PublishConfig = {
        enabled: FEED_IDS.some((id) => feeds[id]),
        feeds,
        rtspBase,
        audio: patch.audio ?? this.config.audio
      };
      if (next.enabled && !next.rtspBase) {
        return { ok: false, code: "RTSP_BASE_REQUIRED", message: "give rtspBase (for example rtsp://127.0.0.1:8554) to enable publishing" } as const;
      }
      const restart = next.rtspBase !== this.config.rtspBase || next.audio !== this.config.audio;
      const feedsChanged = FEED_IDS.some((id) => next.feeds[id] !== this.config.feeds[id]);
      this.config = next;
      this.source = "stored";
      this.file.write(next);
      if (restart) await this.reconcile(true);
      else if (feedsChanged || (next.enabled && !this.feeders)) await this.reconcile(false);
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
    const wanted = FEED_IDS.filter((id) => this.config.feeds[id]);
    if (this.feeders) {
      // Already running: switch single feeds without touching the others.
      if (this.feeders.setActive) this.feeders.setActive(wanted);
      else {
        this.halt();
        return this.reconcile(false);
      }
      return;
    }
    try {
      const feeders = await this.options.create({ rtspBase: this.config.rtspBase, audio: this.config.audio, feeds: wanted });
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

function allFeeds(on: boolean): Record<FeedId, boolean> {
  return { PiPGM1: on, PiPGM2: on, PiPGM3: on };
}

/** Stored settings from before per-feed publishing have only `enabled`: that meant all three feeds. */
function readFeeds(stored: unknown, enabled: boolean): Record<FeedId, boolean> {
  if (!stored || typeof stored !== "object") return allFeeds(enabled);
  const f = stored as Record<string, unknown>;
  return { PiPGM1: f.PiPGM1 === true, PiPGM2: f.PiPGM2 === true, PiPGM3: f.PiPGM3 === true };
}
