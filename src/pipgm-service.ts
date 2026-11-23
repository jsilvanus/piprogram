import { DEFAULT_TIMEZONE, parseUseAt, UseAtError, useAtIntervals } from "./use-at.js";
import { PiSwitchClient, type SlideAdvanceResult } from "./piswitch-client.js";
import { renderPiPgmStageHtml } from "./stage-html.js";
import type { PipgmFrameRenderer } from "./frame.js";
import type { StepImages } from "./step-cache.js";
import type { ManagedStreamSnapshot, PiMatrixEventBroker } from "./types/external.js";
import {
  buildCanvaSteps,
  createCanvaItemData,
  runCanvaConnectExport,
  type CanvaConnectConfig,
  type CanvaPluginPushInput,
  type CanvaControlRequest,
  type CanvaControlResult
} from "./canva-adapter.js";
import {
  buildHymnSteps,
  buildSlideFeed,
  extractYouTubeVideoId,
  getResolutionForOrientation,
  parseHymnStanzasFromText,
  pipgmPipelineDefinitions,
  type CanvaRenderMode,
  type HymnItemData,
  type HymnStanza,
  type PiPgmAsset,
  type PiPgmAudioTrack,
  type PiPgmControlRequest,
  type PiPgmItem,
  type PiPgmMobileAlert,
  type PiPgmMobileSignCode,
  type PiPgmOrientation,
  type PiPgmPipelineId,
  type PiPgmPipelineSnapshot,
  type PiPgmPlaybackState,
  type PptxAnimationEffect
} from "./pipgm-model.js";
import { createTtsEngineFromEnv, readWavInfo, VOICE_NAME, type TtsEngine } from "./tts.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assetsOfEntry, LibraryPersistence } from "./library-store.js";
import type { SavedPlaylistItem } from "./playlist-store.js";
import { buildPptxSteps, parsePptxPresentation } from "./pptx-adapter.js";

interface PipelineInternalState {
  id: PiPgmPipelineId;
  label: string;
  hidden: boolean;
  orientation: PiPgmOrientation;
  fadeToBlack: boolean;
  fadeDurationMs: number;
  /** Chroma key colour (#rrggbb) that fills the stage background and transparent areas; null = normal background. */
  keyColor: string | null;
  audioEnabled: boolean;
  /** Epoch ms when the arming ends; null while disarmed. */
  audioArmedUntil: number | null;
  audioArmTimer: ReturnType<typeof setTimeout> | null;
  audioTrack: PiPgmAudioTrack | null;
  basicImageItemId: string | null;
  volume: number;
  linked: boolean;
  activeItemId: string | null;
  activeEntryId: string | null;
  currentStep: number;
  playbackState: PiPgmPlaybackState;
  playlist: PiPgmItem[];
  /**
   * The entry (entryId) of an item that stays on air after a playlist was loaded over it although the new list does not hold it. It sits
   * first in `playlist` until the feed moves off it, and is then removed. Never stored.
   */
  carriedItemId: string | null;
  stream: ManagedStreamSnapshot;
}

/** `#rrggbb` (lower-cased). Throws on anything else. */
export function normalizeKeyColor(value: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error("keyColor must be #rrggbb");
  return value.toLowerCase();
}

const USE_AT_ZONE = process.env.PIPGM_TIMEZONE?.trim() || DEFAULT_TIMEZONE;

export interface LoadReport {
  mode: "replace" | "append";
  /** Which entries were found, and how (by id, or by the fallback match). */
  resolved: Array<{ index: number; itemId: string; by: "id" | "kindTitle" | "hymnNumber" }>;
  /** Entries that no longer resolve to a library item. Never dropped silently. */
  missing: Array<{ index: number; itemId: string; kind?: string; title?: string; hymn?: { number: number | string } }>;
  /** Entries left out because the item was already in the list. */
  duplicates: Array<{ index: number; itemId: string }>;
  /** Entries that were not acted on: pause markers (stored in saved playlists, not supported on a feed yet). */
  skipped: Array<{ index: number; reason: "pause-not-supported" }>;
  /** The item that stayed on air (replace only), or null when nothing was active. */
  keptActiveItemId: string | null;
  /** True when that item is not in the new list and is carried until the feed moves on. */
  carriedActiveItem: boolean;
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id, i) => id === b[i]);

export interface CreateHymnItemInput {
  title: string;
  hymnNumber?: string;
  includeTitleSlide?: boolean;
  stanzas?: Array<{ stanzaNumber?: string | number; lines: string[]; refrain?: boolean }>;
  rawText?: string;
  targetPipelineId?: PiPgmPipelineId;
  cueImmediately?: boolean;
}

export interface CreateYouTubeItemInput {
  title?: string;
  urlOrId: string;
  startSeconds?: number;
  endSeconds?: number;
  autoplay?: boolean;
  loop?: boolean;
  targetPipelineId?: PiPgmPipelineId;
  cueImmediately?: boolean;
}

export interface CreateUploadedMediaItemInput {
  kind: "video" | "image" | "audio";
  title?: string;
  filename: string;
  mimeType?: string;
  dataBase64?: string;
  fit?: "contain" | "cover";
  caption?: string;
  durationMs?: number;
  autoplay?: boolean;
  loop?: boolean;
  targetPipelineId?: PiPgmPipelineId;
  cueImmediately?: boolean;
}

export interface CreatePptxItemInput {
  title?: string;
  filename: string;
  dataBase64?: string;
  animateBulletsByDefault?: boolean;
  slides?: Array<{
    slideNumber?: number;
    title: string;
    bullets?: string[];
    notes?: string;
    builds?: Array<{
      effect?: PptxAnimationEffect;
      targetText?: string;
      durationMs?: number;
    }>;
  }>;
  targetPipelineId?: PiPgmPipelineId;
  cueImmediately?: boolean;
}

export interface PiPgmServiceOptions {
  eventBroker?: PiMatrixEventBroker | undefined;
  canvaConfig?: CanvaConnectConfig | undefined;
  piswitchUrl?: string | undefined;
  piswitchApiKey?: string | undefined;
  piswitchClient?: PiSwitchClient | undefined;
  autoSyncPiswitch?: boolean | undefined;
  frameRenderer?: PipgmFrameRenderer | undefined;
  /** Highest volume (0-100) any feed plays at, whatever is requested. Default env PIPGM_AUDIO_MAX_VOLUME or 60. */
  audioMaxVolume?: number | undefined;
  /** How long arming lasts when the request gives no length. Default env PIPGM_AUDIO_ARM_SECONDS or 900. */
  audioArmSeconds?: number | undefined;
  /** Clock for tests (epoch ms). */
  now?: (() => number) | undefined;
  /**
   * Directory for prepared speech (WAV + a small JSON per phrase). Phrases survive restarts and are streamed from disk,
   * not held in memory. Undefined = memory only (tests). The server entry point defaults it to ./data/cache.
   */
  cacheDir?: string | undefined;
  /** Text to speech engine; default Piper from PIPGM_TTS_* (undefined = TTS off, prepare answers 503). */
  ttsEngine?: TtsEngine | undefined;
  /** Longest text for one prepared phrase (default env PIPGM_TTS_MAX_CHARS or 500). */
  ttsMaxChars?: number | undefined;
  /** Longest prepared phrase in seconds (default env PIPGM_TTS_MAX_SECONDS or 60). */
  ttsMaxSeconds?: number | undefined;
  /** Days an exported Canva package is kept in the library store (default env PIPGM_CANVA_RETENTION_DAYS or 60; 0 = forever). */
  canvaRetentionDays?: number | undefined;
  /** Largest audio file in bytes, for prepared WAVs and uploaded audio (default env PIPGM_AUDIO_MAX_BYTES or 20 MB). */
  audioMaxBytes?: number | undefined;
  /** Prepared phrases kept; the oldest is dropped beyond this (default env PIPGM_TTS_MAX_ITEMS or 50). */
  ttsMaxItems?: number | undefined;
  /** Total bytes of prepared phrases kept (default env PIPGM_TTS_MAX_TOTAL_BYTES or 100 MB). */
  ttsMaxTotalBytes?: number | undefined;
  /**
   * Durable storage (pistorage) for uploaded media and library items. Undefined = memory only, as before.
   * Call loadLibrary() once at start to read what was stored.
   */
  libraryStore?: LibraryPersistence | undefined;
  /** Pre-rendered step image cache (pistorage). */
  stepImages?: StepImages | undefined;
}

export type PrepareSpeechErrorCode =
  | "TEXT_REQUIRED"
  | "TEXT_TOO_LONG"
  | "INVALID_VOICE"
  | "TTS_NOT_CONFIGURED"
  | "TTS_BUSY"
  | "TTS_FAILED"
  | "TTS_BAD_AUDIO"
  | "TTS_TOO_LONG"
  | "TTS_TOO_LARGE";

export type PrepareSpeechResult =
  | { ok: true; item: PiPgmItem; cached: boolean }
  | { ok: false; code: PrepareSpeechErrorCode; message: string };

interface PreparedSpeech {
  itemId: string;
  assetId: string;
  bytes: number;
  createdAt: string;
}

interface PreparedMeta {
  key: string;
  text: string;
  voice: string | null;
  title: string;
  durationMs: number;
  bytes: number;
  createdAt: string;
}

const MAX_TTS_WAITING = 3;

function positiveFromEnv(name: string, fallback: number): number {
  const value = numberFromEnv(name);
  return value !== undefined && value > 0 ? value : fallback;
}

export const MAX_AUDIO_ARM_SECONDS = 3600;

function numberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export type PlayAudioResult =
  | { ok: true; pipeline: PiPgmPipelineSnapshot }
  | { ok: false; code: "PIPELINE_NOT_FOUND" | "AUDIO_NOT_ARMED" | "ITEM_NOT_FOUND" | "ITEM_NOT_AUDIO" };

export class PiPgmService {
  private readonly pipelines = new Map<PiPgmPipelineId, PipelineInternalState>();
  private readonly library = new Map<string, PiPgmItem>();
  private readonly assets = new Map<string, PiPgmAsset>();
  private readonly eventBroker?: PiMatrixEventBroker | undefined;
  private readonly canvaConfig: CanvaConnectConfig;
  private readonly piswitchClient?: PiSwitchClient | undefined;
  private readonly autoSyncPiswitch: boolean;
  private readonly frameRenderer?: PipgmFrameRenderer | undefined;
  private stepImages?: StepImages | undefined;
  private readonly ttsEngine: TtsEngine | undefined;
  readonly ttsMaxChars: number;
  readonly ttsMaxSeconds: number;
  readonly audioMaxBytes: number;
  private readonly ttsMaxItems: number;
  private readonly ttsMaxTotalBytes: number;
  private readonly prepared = new Map<string, PreparedSpeech>();
  private readonly ttsDir: string | undefined;
  private ttsTail: Promise<unknown> = Promise.resolve();
  private ttsWaiting = 0;
  private readonly audioMaxVolume: number;
  private readonly canvaRetentionDays: number;
  private readonly audioArmSeconds: number;
  private readonly now: () => number;
  private idCounter = 1;
  private readonly libraryStore: LibraryPersistence | undefined;
  /** Items whose last write to the store failed (or is running), with the reason. Retried by flushLibrary(). */
  private readonly unsaved = new Map<string, { assetIds: string[]; expiresAt: string | undefined; error: string | null; metadataOnly?: boolean }>();
  private readonly savedItems = new Set<string>();
  /** Feeds whose live playlist changed and is not stored yet. */
  private readonly liveDirty = new Set<PiPgmPipelineId>();
  /** True once the stored live playlists have been read (or there is no store); only then are they written. */
  private liveRestored = false;

  constructor(options: PiPgmServiceOptions = {}) {
    this.eventBroker = options.eventBroker;
    this.libraryStore = options.libraryStore;
    this.canvaRetentionDays = Math.max(0, options.canvaRetentionDays ?? numberFromEnv("PIPGM_CANVA_RETENTION_DAYS") ?? 60);
    this.canvaConfig = options.canvaConfig ?? {};
    this.frameRenderer = options.frameRenderer;
    this.stepImages = options.stepImages;
    this.now = options.now ?? Date.now;
    this.ttsEngine = "ttsEngine" in options ? options.ttsEngine : createTtsEngineFromEnv();
    this.ttsMaxChars = Math.round(options.ttsMaxChars ?? positiveFromEnv("PIPGM_TTS_MAX_CHARS", 500));
    this.ttsMaxSeconds = options.ttsMaxSeconds ?? positiveFromEnv("PIPGM_TTS_MAX_SECONDS", 60);
    this.audioMaxBytes = Math.round(options.audioMaxBytes ?? positiveFromEnv("PIPGM_AUDIO_MAX_BYTES", 20 * 1024 * 1024));
    this.ttsMaxItems = Math.round(options.ttsMaxItems ?? positiveFromEnv("PIPGM_TTS_MAX_ITEMS", 50));
    this.ttsMaxTotalBytes = Math.round(options.ttsMaxTotalBytes ?? positiveFromEnv("PIPGM_TTS_MAX_TOTAL_BYTES", 100 * 1024 * 1024));
    this.audioMaxVolume = Math.max(
      0,
      Math.min(100, Math.round(options.audioMaxVolume ?? numberFromEnv("PIPGM_AUDIO_MAX_VOLUME") ?? 60))
    );
    this.audioArmSeconds = Math.max(
      1,
      Math.min(MAX_AUDIO_ARM_SECONDS, Math.round(options.audioArmSeconds ?? numberFromEnv("PIPGM_AUDIO_ARM_SECONDS") ?? 900))
    );
    if (options.piswitchClient) {
      this.piswitchClient = options.piswitchClient;
    } else if (options.piswitchUrl || process.env.PISWITCH_URL) {
      this.piswitchClient = new PiSwitchClient({
        baseUrl: options.piswitchUrl,
        apiKey: options.piswitchApiKey
      });
    }
    this.autoSyncPiswitch = options.autoSyncPiswitch ?? (this.piswitchClient !== undefined);

    if (options.cacheDir) {
      this.ttsDir = join(options.cacheDir, "tts");
      mkdirSync(this.ttsDir, { recursive: true });
      this.loadPrepared();
      this.feedSettingsPath = join(options.cacheDir, "feed-settings.json");
    }

    for (const def of pipgmPipelineDefinitions) {
      this.pipelines.set(def.id, {
        id: def.id,
        label: def.label,
        hidden: def.defaultHidden,
        orientation: def.defaultOrientation,
        fadeToBlack: false,
        fadeDurationMs: 500,
        keyColor: null,
        audioEnabled: false, // Muted by default ("usually we work muted, but sometimes sound is required")
        audioArmedUntil: null,
        audioArmTimer: null,
        audioTrack: null,
        basicImageItemId: null,
        volume: 100,
        linked: false,
        activeItemId: null,
        activeEntryId: null,
        currentStep: 0,
        playbackState: "stopped",
        playlist: [],
        carriedItemId: null,
        stream: {
          state: "disabled",
          jobId: null,
          attempt: 0,
          lastError: null,
          stderrTail: null
        }
      });
    }
    this.loadFeedSettings();
  }

  private nextId(prefix: string): string {
    const id = `${prefix}-${this.idCounter}`;
    this.idCounter += 1;
    return id;
  }

  isValidPipelineId(id: string): id is PiPgmPipelineId {
    return this.pipelines.has(id as PiPgmPipelineId);
  }

  listPipelines(includeHidden = true): PiPgmPipelineSnapshot[] {
    const results: PiPgmPipelineSnapshot[] = [];
    for (const state of this.pipelines.values()) {
      if (!includeHidden && state.hidden) continue;
      results.push(this.toSnapshot(state));
    }
    return results;
  }

  getPipeline(pipelineId: string): PiPgmPipelineSnapshot | undefined {
    const state = this.pipelines.get(pipelineId as PiPgmPipelineId);
    return state ? this.toSnapshot(state) : undefined;
  }

  isPipelineHidden(pipelineId: PiPgmPipelineId): boolean {
    return this.pipelines.get(pipelineId)?.hidden ?? false;
  }

  isPipelineActiveOnMultiview(pipelineId: PiPgmPipelineId): boolean {
    const state = this.pipelines.get(pipelineId);
    if (!state) return false;
    return !state.hidden || state.activeItemId !== null || state.stream.state === "running";
  }

  listLibraryItems(): PiPgmItem[] {
    return [...this.library.values()].map((item) => structuredClone(item));
  }

  getLibraryItem(itemId: string): PiPgmItem | undefined {
    const found = this.library.get(itemId);
    return found ? structuredClone(found) : undefined;
  }

  /** Writes a library item (and its uploaded bytes) to the store. A failure is kept and retried, never dropped. */
  private persistItem(itemId: string, assetIds: string | string[] = [], expiresAt?: string, metadataOnly = false): void {
    if (!this.libraryStore) return;
    this.unsaved.set(itemId, { assetIds: Array.isArray(assetIds) ? assetIds : [assetIds], expiresAt, error: null, ...(metadataOnly ? { metadataOnly } : {}) });
    void this.writeItem(itemId);
  }

  private async writeItem(itemId: string): Promise<void> {
    const store = this.libraryStore;
    const pending = this.unsaved.get(itemId);
    const item = this.library.get(itemId);
    if (!store || !pending || !item) {
      this.unsaved.delete(itemId);
      return;
    }
    const assets = pending.assetIds.map((id) => this.assets.get(id)).filter((a): a is PiPgmAsset => a !== undefined);
    try {
      await store.save(item, assets, pending.expiresAt, { metadataOnly: pending.metadataOnly === true });
      this.savedItems.add(itemId);
      if (this.unsaved.get(itemId) === pending) this.unsaved.delete(itemId);
    } catch (error) {
      pending.error = error instanceof Error ? error.message : String(error);
    }
  }

  /** Retries every item that is not stored yet. Returns how many are still unsaved. */
  async flushLibrary(): Promise<number> {
    await Promise.all([...this.unsaved.keys()].map((id) => this.writeItem(id)));
    await this.flushLivePlaylists();
    return this.unsaved.size + this.liveDirty.size;
  }

  /** Marks a feed's playlist as changed; it is written to the store (ids only) once the stored ones have been read. */
  private persistLivePlaylist(pipelineId: PiPgmPipelineId): void {
    if (!this.libraryStore) return;
    this.liveDirty.add(pipelineId);
    if (this.liveRestored) void this.flushLivePlaylists();
  }

  /** A playlist entry for a library item: a copy with its own entry id, so the same item can be listed again. */
  private newEntry(item: PiPgmItem): PiPgmItem {
    return { ...structuredClone(item), entryId: `ent_${randomUUID().replaceAll("-", "").slice(0, 10)}` };
  }

  /** Puts an entry on air (or nothing, with null). */
  private setActive(state: PipelineInternalState, entry: PiPgmItem | null | undefined): void {
    state.activeItemId = entry?.id ?? null;
    state.activeEntryId = entry?.entryId ?? null;
  }

  private activeEntry(state: PipelineInternalState): PiPgmItem | undefined {
    return state.activeEntryId === null ? undefined : state.playlist.find((i) => i.entryId === state.activeEntryId);
  }

  /** The playlist as stored: the item carried over from a loaded playlist is not part of it. */
  private liveIdsOf(state: PipelineInternalState): string[] {
    return state.playlist.filter((i) => i.entryId !== state.carriedItemId).map((i) => i.id);
  }

  private async flushLivePlaylists(): Promise<void> {
    const store = this.libraryStore;
    if (!store || !this.liveRestored) return;
    await Promise.all(
      [...this.liveDirty].map(async (id) => {
        const state = this.pipelines.get(id);
        if (!state) return;
        const ids = this.liveIdsOf(state);
        try {
          await store.saveLivePlaylist(id, ids);
          if (this.liveDirty.has(id) && sameIds(ids, this.liveIdsOf(state))) this.liveDirty.delete(id);
        } catch {
          // stays dirty; flushLibrary() retries
        }
      })
    );
  }

  /**
   * Puts the stored playlists back after a restart. A feed that already changed meanwhile is left as it is (and written
   * later); items that are no longer in the library are skipped and reported through onSkip. Nothing goes on air: the
   * feeds start with no active item, as before.
   */
  private async restoreLivePlaylists(onSkip?: (key: string, reason: string) => void): Promise<void> {
    const store = this.libraryStore;
    if (!store) return;
    for (const [id, state] of this.pipelines) {
      if (this.liveDirty.has(id) || state.playlist.length > 0) continue;
      const ids = await store.loadLivePlaylist(id);
      if (!ids) continue;
      for (const itemId of ids) {
        const item = this.library.get(itemId);
        if (item) state.playlist.push(this.newEntry(item));
        else onSkip?.(`live/${id}`, `item ${itemId} is no longer in the library`);
      }
    }
  }

  libraryStorageStatus(): { enabled: boolean; stored: number; unsaved: Array<{ itemId: string; error: string | null }> } {
    return {
      enabled: this.libraryStore !== undefined,
      stored: this.savedItems.size,
      unsaved: [...this.unsaved].map(([itemId, v]) => ({ itemId, error: v.error }))
    };
  }

  /**
   * Reads the stored library at start. Asset bytes stay in the store and are fetched when served.
   * Items already present (prepared speech) are kept. Returns the number of items loaded.
   */
  async loadLibrary(onSkip?: (key: string, reason: string) => void): Promise<number> {
    if (!this.libraryStore) return 0;
    const entries = await this.libraryStore.loadAll(onSkip);
    let maxId = this.idCounter - 1;
    for (const entry of entries) {
      this.library.set(entry.item.id, entry.item);
      this.savedItems.add(entry.item.id);
      const entryAssets = assetsOfEntry(entry);
      for (const asset of entryAssets) this.assets.set(asset.id, { ...asset, stored: true });
      for (const id of [entry.item.id, ...entryAssets.map((a) => a.id)]) {
        const n = /-(\d+)$/.exec(id);
        if (n) maxId = Math.max(maxId, Number(n[1]));
      }
    }
    this.idCounter = maxId + 1;
    await this.restoreLivePlaylists(onSkip);
    this.liveRestored = true;
    await this.flushLivePlaylists();
    return entries.length;
  }

  /** The bytes of an asset kept in the store (null: not there). */
  async readStoredAsset(assetId: string): Promise<Buffer | null> {
    return this.libraryStore ? this.libraryStore.readAsset(assetId) : null;
  }

  /** Reads an asset's bytes whether held in memory, on disk, or in pistorage. */
  async readAssetBytes(assetId: string): Promise<Buffer | null> {
    const asset = this.assets.get(assetId);
    if (!asset) return null;
    if (asset.data) return asset.data;
    if (asset.stored) return this.readStoredAsset(asset.id);
    if (asset.filePath) return readFile(asset.filePath);
    return null;
  }

  /** The file of an audio library item (null: no such item, not audio, or no bytes). */
  async readAudioItemBytes(itemId: string): Promise<Buffer | null> {
    const item = this.library.get(itemId);
    if (!item || item.kind !== "audio" || !item.audio) return null;
    return this.readAssetBytes(item.audio.assetId);
  }

  setStepImages(steps: StepImages): void {
    this.stepImages = steps;
  }

  /** Removes a library item, its uploaded bytes and its place in every playlist. False when unknown. */
  /** The ids of the uploaded files that belong to an item. */
  private assetIdsOf(item: PiPgmItem): string[] {
    return [
      item.image?.assetId ?? item.audio?.assetId ?? item.video?.assetId ?? item.pptx?.assetId,
      ...(item.canva?.pages.map((p) => p.assetId) ?? [])
    ].filter((id): id is string => typeof id === "string");
  }

  /**
   * Sets when an item is meant to be used (null or an empty list clears it) and writes the item and
   * its files to the store again, so that pistorage can have them in the Pi cache beforehand.
   * Throws UseAtError for a value that is not valid. Step pictures made earlier keep no date.
   */
  setUseAt(itemId: string, input: string | readonly string[] | null): PiPgmItem | "ITEM_NOT_FOUND" {
    const item = this.library.get(itemId);
    if (!item) return "ITEM_NOT_FOUND";
    const useAt = input === null ? [] : parseUseAt(input, USE_AT_ZONE);
    if (useAt.length > 0) item.useAt = useAt;
    else delete item.useAt;
    // Once the item is in the store, only its date changes there; the page files are not sent again.
    this.persistItem(itemId, this.assetIdsOf(item), this.expiryOf(item), this.savedItems.has(itemId));
    return structuredClone(item);
  }

  /** The retention deadline an item's files carry in the store (Canva pages only). */
  private expiryOf(item: PiPgmItem): string | undefined {
    if (item.kind !== "canva" || this.canvaRetentionDays <= 0) return undefined;
    return new Date(this.now() + this.canvaRetentionDays * 86_400_000).toISOString();
  }

  async deleteLibraryItem(itemId: string): Promise<boolean> {
    const item = this.library.get(itemId);
    if (!item) return false;
    const assetIds = this.assetIdsOf(item);
    this.library.delete(itemId);
    for (const id of assetIds) this.assets.delete(id);
    this.unsaved.delete(itemId);
    this.savedItems.delete(itemId);
    for (const state of this.pipelines.values()) {
      const before = state.playlist.length;
      const carried = state.playlist.find((i) => i.entryId === state.carriedItemId);
      state.playlist = state.playlist.filter((i) => i.id !== itemId);
      if (carried?.id === itemId) state.carriedItemId = null;
      else if (state.playlist.length !== before) this.persistLivePlaylist(state.id);
      if (state.activeItemId === itemId) this.setActive(state, null);
      if (state.basicImageItemId === itemId) state.basicImageItemId = null;
    }
    await this.libraryStore?.remove(itemId, assetIds);
    return true;
  }

  /**
   * A pipeline snapshot that shows one step of a library item, built on the side: no real pipeline
   * changes. Used to render step pictures ahead of time. Null for an unknown item or step.
   */
  snapshotForStep(itemId: string, step: number, orientation: PiPgmOrientation): PiPgmPipelineSnapshot | null {
    const item = this.library.get(itemId);
    const base = this.pipelines.get("PiPGM1");
    if (!item || !item.steps[step] || !base) return null;
    const previewEntry = this.newEntry(item);
    return this.toSnapshot({
      id: base.id,
      label: base.label,
      hidden: false,
      orientation,
      fadeToBlack: false,
      keyColor: null,
      fadeDurationMs: 0,
      audioEnabled: false,
      audioArmedUntil: null,
      audioArmTimer: null,
      audioTrack: null,
      basicImageItemId: null,
      volume: 0,
      linked: false,
      activeItemId: item.id,
      activeEntryId: previewEntry.entryId ?? null,
      currentStep: step,
      playbackState: "playing",
      playlist: [previewEntry],
      carriedItemId: null,
      stream: { ...base.stream }
    });
  }

  getAsset(assetId: string): PiPgmAsset | undefined {
    return this.assets.get(assetId);
  }

  updatePipelineConfig(
    pipelineId: string,
    patch: {
      orientation?: PiPgmOrientation;
      hidden?: boolean;
      linked?: boolean;
      fadeDurationMs?: number;
      keyColor?: string | null;
    }
  ): PiPgmPipelineSnapshot | undefined {
    const state = this.pipelines.get(pipelineId as PiPgmPipelineId);
    if (!state) return undefined;

    if (patch.orientation !== undefined) {
      state.orientation = patch.orientation;
    }
    if (patch.hidden !== undefined) {
      state.hidden = patch.hidden;
    }
    if (patch.linked !== undefined) {
      state.linked = patch.linked;
    }
    if (patch.fadeDurationMs !== undefined) {
      state.fadeDurationMs = Math.max(0, Math.min(10000, Math.round(patch.fadeDurationMs)));
    }
    if (patch.keyColor !== undefined) {
      state.keyColor = patch.keyColor === null ? null : normalizeKeyColor(patch.keyColor);
      this.saveFeedSettings();
    }

    const snapshot = this.toSnapshot(state);
    this.emitPipelineEvent("config", snapshot);
    return snapshot;
  }

  setFadeToBlack(
    pipelineId: string,
    options: { fadeToBlack?: boolean; toggle?: boolean; durationMs?: number; sync?: boolean },
    isSyncedCall = false
  ): PiPgmPipelineSnapshot | undefined {
    const state = this.pipelines.get(pipelineId as PiPgmPipelineId);
    if (!state) return undefined;

    const targetFtb = options.toggle
      ? !state.fadeToBlack
      : (options.fadeToBlack ?? !state.fadeToBlack);

    state.fadeToBlack = targetFtb;
    if (options.durationMs !== undefined) {
      state.fadeDurationMs = Math.max(0, Math.min(10000, Math.round(options.durationMs)));
    }

    const snapshot = this.toSnapshot(state);
    this.emitPipelineEvent("ftb", snapshot);

    if (!isSyncedCall && (options.sync || state.linked)) {
      for (const peer of this.pipelines.values()) {
        if (peer.id !== state.id && peer.linked) {
          this.setFadeToBlack(
            peer.id,
            {
              fadeToBlack: targetFtb,
              ...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {})
            },
            true
          );
        }
      }
    }

    return snapshot;
  }

  setAudio(
    pipelineId: string,
    options: { audioEnabled?: boolean; toggle?: boolean; volume?: number; armSeconds?: number; sync?: boolean },
    isSyncedCall = false
  ): PiPgmPipelineSnapshot | undefined {
    const state = this.pipelines.get(pipelineId as PiPgmPipelineId);
    if (!state) return undefined;
    this.expireArming(state);

    const wasArmed = state.audioEnabled;
    if (options.toggle) {
      state.audioEnabled = !state.audioEnabled;
    } else if (options.audioEnabled !== undefined) {
      state.audioEnabled = options.audioEnabled;
    }

    if (state.audioEnabled) {
      // Arming (or re-arming with a new length) always has an end; it never lasts for ever.
      if (!wasArmed || options.armSeconds !== undefined) {
        this.armUntil(state, options.armSeconds ?? this.audioArmSeconds);
      }
    } else {
      this.disarm(state);
    }

    if (options.volume !== undefined) {
      state.volume = Math.max(0, Math.min(100, Math.round(options.volume)));
    }

    const snapshot = this.toSnapshot(state);
    this.emitPipelineEvent("audio", snapshot);

    if (!isSyncedCall && options.sync) {
      for (const peer of this.pipelines.values()) {
        if (peer.id !== state.id && peer.linked) {
          this.setAudio(
            peer.id,
            {
              audioEnabled: state.audioEnabled,
              volume: state.volume,
              ...(state.audioEnabled && options.armSeconds !== undefined ? { armSeconds: options.armSeconds } : {})
            },
            true
          );
        }
      }
    }

    return snapshot;
  }

  /** Start an audio library item as the feed's audio content. Refused unless the feed is armed. */
  playAudio(
    pipelineId: string,
    options: { itemId: string; loop?: boolean; volume?: number }
  ): PlayAudioResult {
    const state = this.pipelines.get(pipelineId as PiPgmPipelineId);
    if (!state) return { ok: false, code: "PIPELINE_NOT_FOUND" };
    this.expireArming(state);
    if (!state.audioEnabled) return { ok: false, code: "AUDIO_NOT_ARMED" };
    const item = this.library.get(options.itemId);
    if (!item) return { ok: false, code: "ITEM_NOT_FOUND" };
    if (item.kind !== "audio" || !item.audio) return { ok: false, code: "ITEM_NOT_AUDIO" };

    if (options.volume !== undefined) {
      state.volume = Math.max(0, Math.min(100, Math.round(options.volume)));
    }
    state.audioTrack = {
      playId: this.nextId("play"),
      itemId: item.id,
      title: item.title,
      assetUrl: item.audio.assetUrl,
      loop: options.loop ?? item.audio.loop,
      startedAt: new Date(this.now()).toISOString()
    };
    const snapshot = this.toSnapshot(state);
    this.emitPipelineEvent("audio:play", snapshot);
    return { ok: true, pipeline: snapshot };
  }

  /** Stop the audio track of one feed. The feed stays armed. */
  stopAudio(pipelineId: string): PiPgmPipelineSnapshot | undefined {
    const state = this.pipelines.get(pipelineId as PiPgmPipelineId);
    if (!state) return undefined;
    state.audioTrack = null;
    const snapshot = this.toSnapshot(state);
    this.emitPipelineEvent("audio:stop", snapshot);
    return snapshot;
  }

  /**
   * Kill switch: on every feed, stop the track, disarm and mute at once. Video items on a feed
   * go silent too, because they play only while the feed is armed.
   */
  killAudio(): PiPgmPipelineSnapshot[] {
    const results: PiPgmPipelineSnapshot[] = [];
    for (const state of this.pipelines.values()) {
      state.audioTrack = null;
      state.audioEnabled = false;
      this.disarm(state);
      const snapshot = this.toSnapshot(state);
      this.emitPipelineEvent("audio:kill", snapshot);
      results.push(snapshot);
    }
    return results;
  }

  /**
   * Render a phrase to a WAV ahead of time and keep it as an audio library item, so playing it later
   * (audio/play) is instant. The same text and voice give the same item back without rendering again.
   * Limits: text length, file size, length in seconds, and how many/how many bytes of prepared phrases
   * are kept (the oldest is dropped; one that is playing is kept). One render runs at a time, so the Pi is not
   * overloaded, and at most a few wait.
   */
  async prepareSpeech(input: { text: string; voice?: string | undefined; title?: string | undefined }): Promise<PrepareSpeechResult> {
    const text = input.text.replace(/\s+/g, " ").trim();
    if (!text) return { ok: false, code: "TEXT_REQUIRED", message: "text is required" };
    if (text.length > this.ttsMaxChars) {
      return { ok: false, code: "TEXT_TOO_LONG", message: `text is longer than ${this.ttsMaxChars} characters` };
    }
    if (input.voice !== undefined && !VOICE_NAME.test(input.voice)) {
      return { ok: false, code: "INVALID_VOICE", message: "voice must be a plain name such as fi_FI-harri-medium" };
    }
    if (!this.ttsEngine) {
      return { ok: false, code: "TTS_NOT_CONFIGURED", message: "Text to speech is not set up (PIPGM_TTS_MODEL_DIR)" };
    }

    const key = createHash("sha256").update(`${input.voice ?? ""}\n${text}`).digest("hex").slice(0, 16);
    const hit = this.prepared.get(key);
    const hitItem = hit ? this.library.get(hit.itemId) : undefined;
    if (hit && hitItem) {
      this.prepared.delete(key); // keep the newest use last, so it is dropped last
      this.prepared.set(key, hit);
      return { ok: true, item: structuredClone(hitItem), cached: true };
    }

    if (this.ttsWaiting >= MAX_TTS_WAITING) {
      return { ok: false, code: "TTS_BUSY", message: "Too many phrases are being prepared; try again shortly" };
    }
    this.ttsWaiting += 1;
    const engine = this.ttsEngine;
    const run = this.ttsTail.then(async (): Promise<PrepareSpeechResult> => {
      const again = this.prepared.get(key);
      const againItem = again ? this.library.get(again.itemId) : undefined;
      if (again && againItem) return { ok: true, item: structuredClone(againItem), cached: true };

      let wav: Buffer;
      try {
        wav = await engine.synthesize(text, { voice: input.voice });
      } catch (error) {
        return { ok: false, code: "TTS_FAILED", message: error instanceof Error ? error.message : "synthesis failed" };
      }
      if (wav.length > this.audioMaxBytes) {
        return { ok: false, code: "TTS_TOO_LARGE", message: `the rendered file is larger than ${this.audioMaxBytes} bytes` };
      }
      const info = readWavInfo(wav);
      if (!info || info.durationMs <= 0) {
        return { ok: false, code: "TTS_BAD_AUDIO", message: "the engine did not return a usable WAV" };
      }
      if (info.durationMs > this.ttsMaxSeconds * 1000) {
        return { ok: false, code: "TTS_TOO_LONG", message: `the rendered speech is longer than ${this.ttsMaxSeconds} seconds` };
      }

      const meta: PreparedMeta = {
        key,
        text,
        voice: input.voice ?? null,
        title: input.title?.trim() || text.slice(0, 60),
        durationMs: info.durationMs,
        bytes: wav.length,
        createdAt: new Date(this.now()).toISOString()
      };
      let item: PiPgmItem;
      if (this.ttsDir) {
        try {
          const target = join(this.ttsDir, `${key}.wav`);
          await writeFile(`${target}.tmp`, wav);
          await rename(`${target}.tmp`, target);
          await writeFile(join(this.ttsDir, `${key}.json`), JSON.stringify(meta));
        } catch (error) {
          return { ok: false, code: "TTS_FAILED", message: `could not store the file: ${error instanceof Error ? error.message : "write failed"}` };
        }
        item = this.registerPrepared(meta, { filePath: join(this.ttsDir, `${key}.wav`) });
      } else {
        item = this.registerPrepared(meta, { data: wav });
      }
      this.evictPrepared(item.id);
      return { ok: true, item, cached: false };
    });
    this.ttsTail = run.catch(() => undefined);
    try {
      return await run;
    } finally {
      this.ttsWaiting -= 1;
    }
  }

  /**
   * Checks an uploaded audio file against the same limits as prepared speech: size, and for a WAV a valid header
   * and a length of at most ttsMaxSeconds. Other formats (mp3 and so on) are only size-checked, and their length is not known.
   */
  checkAudioUpload(buffer: Buffer, mimeType: string, filename: string):
    | { ok: true; durationMs?: number }
    | { ok: false; code: "AUDIO_TOO_LARGE" | "INVALID_WAV" | "AUDIO_TOO_LONG"; message: string } {
    if (buffer.length > this.audioMaxBytes) {
      return { ok: false, code: "AUDIO_TOO_LARGE", message: `audio files can be at most ${this.audioMaxBytes} bytes` };
    }
    const isWav = /wav/i.test(mimeType) || /\.wav$/i.test(filename);
    if (!isWav) return { ok: true };
    const info = readWavInfo(buffer);
    if (!info || info.durationMs <= 0) {
      return { ok: false, code: "INVALID_WAV", message: "the file is not a usable PCM WAV" };
    }
    if (info.durationMs > this.ttsMaxSeconds * 1000) {
      return { ok: false, code: "AUDIO_TOO_LONG", message: `WAV files can be at most ${this.ttsMaxSeconds} seconds` };
    }
    return { ok: true, durationMs: info.durationMs };
  }

  /** Adds a prepared phrase to the library (ids are stable: the same phrase has the same ids after a restart). */
  private registerPrepared(meta: PreparedMeta, source: { filePath: string } | { data: Buffer }): PiPgmItem {
    const itemId = `tts-${meta.key}`;
    const assetId = `asset-tts-${meta.key}`;
    const assetUrl = `/api/v1/pipgm/assets/${encodeURIComponent(assetId)}`;
    const filename = `tts-${meta.key}.wav`;
    this.assets.set(assetId, {
      id: assetId,
      filename,
      mimeType: "audio/wav",
      kind: "audio",
      sizeBytes: meta.bytes,
      createdAt: meta.createdAt,
      url: assetUrl,
      ...source
    });
    const item: PiPgmItem = {
      id: itemId,
      title: meta.title,
      kind: "audio",
      createdAt: meta.createdAt,
      steps: [
        {
          stepIndex: 0,
          totalSteps: 1,
          label: meta.title,
          subLabel: filename,
          slideNumber: 1,
          previewText: [meta.title],
          assetUrl
        }
      ],
      audio: { assetId, filename, mimeType: "audio/wav", assetUrl, durationMs: meta.durationMs, loop: false }
    };
    this.library.set(itemId, item);
    this.prepared.set(meta.key, { itemId, assetId, bytes: meta.bytes, createdAt: meta.createdAt });
    return structuredClone(item);
  }

  /** Reads the cache directory at start. Entries whose files are missing or changed are ignored; the limits apply as usual. */
  private feedSettingsPath: string | undefined;

  /** Reads the stored per-feed settings (key colour). A missing or broken file means defaults. */
  private loadFeedSettings(): void {
    if (!this.feedSettingsPath || !existsSync(this.feedSettingsPath)) return;
    try {
      const data = JSON.parse(readFileSync(this.feedSettingsPath, "utf8")) as Record<string, { keyColor?: unknown }>;
      for (const state of this.pipelines.values()) {
        const key = data[state.id]?.keyColor;
        if (typeof key === "string") {
          try {
            state.keyColor = normalizeKeyColor(key);
          } catch {
            // an invalid stored value is ignored
          }
        }
      }
    } catch {
      // unreadable settings: defaults
    }
  }

  private saveFeedSettings(): void {
    if (!this.feedSettingsPath) return;
    const data: Record<string, { keyColor: string | null }> = {};
    for (const state of this.pipelines.values()) data[state.id] = { keyColor: state.keyColor };
    try {
      writeFileSync(this.feedSettingsPath, JSON.stringify(data, null, 2), "utf8");
    } catch {
      // the setting still works in memory
    }
  }

  private loadPrepared(): void {
    if (!this.ttsDir) return;
    const metas: PreparedMeta[] = [];
    for (const name of readdirSync(this.ttsDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const meta = JSON.parse(readFileSync(join(this.ttsDir, name), "utf8")) as PreparedMeta;
        const wavPath = join(this.ttsDir, `${meta.key}.wav`);
        if (!/^[a-f0-9]{16}$/.test(meta.key) || name !== `${meta.key}.json`) continue;
        if (!existsSync(wavPath) || statSync(wavPath).size !== meta.bytes) continue;
        metas.push(meta);
      } catch {
        // an unreadable entry is skipped; it is cleaned up when the cache is next pruned
      }
    }
    metas.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const meta of metas) {
      this.registerPrepared(meta, { filePath: join(this.ttsDir, `${meta.key}.wav`) });
    }
    this.evictPrepared("");
  }

  /** Drops the oldest prepared phrases beyond the count and byte limits. Never the one just made or one that is playing. */
  private evictPrepared(keepItemId: string): void {
    const playing = new Set<string>();
    for (const state of this.pipelines.values()) {
      if (state.audioTrack) playing.add(state.audioTrack.itemId);
    }
    const total = (): number => [...this.prepared.values()].reduce((sum, p) => sum + p.bytes, 0);
    for (const [key, entry] of this.prepared) {
      if (this.prepared.size <= this.ttsMaxItems && total() <= this.ttsMaxTotalBytes) break;
      if (entry.itemId === keepItemId || playing.has(entry.itemId)) continue;
      this.prepared.delete(key);
      this.library.delete(entry.itemId);
      this.assets.delete(entry.assetId);
      if (this.ttsDir) {
        for (const ext of ["wav", "json", "wav.tmp"]) {
          void rm(join(this.ttsDir, `${key}.${ext}`), { force: true }).catch(() => undefined);
        }
      }
      for (const state of this.pipelines.values()) {
        const before = state.playlist.length;
        state.playlist = state.playlist.filter((i) => i.id !== entry.itemId);
        if (state.playlist.length !== before) this.persistLivePlaylist(state.id);
        if (state.activeItemId === entry.itemId) this.setActive(state, null);
      }
    }
  }

  /** Choose (or clear with null) the optional basic image: an image library item shown when nothing else is active. */
  setBasicImage(pipelineId: string, itemId: string | null): PiPgmPipelineSnapshot | "ITEM_NOT_FOUND" | "ITEM_NOT_IMAGE" | undefined {
    const state = this.pipelines.get(pipelineId as PiPgmPipelineId);
    if (!state) return undefined;
    if (itemId !== null) {
      const item = this.library.get(itemId);
      if (!item) return "ITEM_NOT_FOUND";
      if (item.kind !== "image" || !item.image) return "ITEM_NOT_IMAGE";
    }
    state.basicImageItemId = itemId;
    const snapshot = this.toSnapshot(state);
    this.emitPipelineEvent("basic-image", snapshot);
    return snapshot;
  }

  private armUntil(state: PipelineInternalState, seconds: number): void {
    const clamped = Math.max(1, Math.min(MAX_AUDIO_ARM_SECONDS, Math.round(seconds)));
    this.clearArmTimer(state);
    state.audioArmedUntil = this.now() + clamped * 1000;
    const timer = setTimeout(() => {
      state.audioArmTimer = null;
      if (this.expireArming(state)) {
        this.emitPipelineEvent("audio:expired", this.toSnapshot(state));
      }
    }, clamped * 1000 + 50); // a little late, so the clock has passed the end
    timer.unref();
    state.audioArmTimer = timer;
  }

  private disarm(state: PipelineInternalState): void {
    this.clearArmTimer(state);
    state.audioEnabled = false;
    state.audioArmedUntil = null;
    state.audioTrack = null;
  }

  private clearArmTimer(state: PipelineInternalState): void {
    if (state.audioArmTimer) {
      clearTimeout(state.audioArmTimer);
      state.audioArmTimer = null;
    }
  }

  /** Ends arming once its time is up. Returns true when it did. Also runs before reads, so a late timer cannot leave sound armed. */
  private expireArming(state: PipelineInternalState): boolean {
    if (!state.audioEnabled || state.audioArmedUntil === null) return false;
    if (this.now() < state.audioArmedUntil) return false;
    this.disarm(state);
    return true;
  }

  control(
    pipelineId: string,
    request: PiPgmControlRequest,
    isSyncedCall = false
  ): PiPgmPipelineSnapshot | undefined {
    const state = this.pipelines.get(pipelineId as PiPgmPipelineId);
    if (!state) return undefined;

    const advanceItemOnEnd = request.advanceItemOnEnd ?? false;
    const activeIndex = state.playlist.findIndex((i) => i.entryId === state.activeEntryId);
    const activeItem = activeIndex >= 0 ? state.playlist[activeIndex] : undefined;

    switch (request.action) {
      case "gotoItem": {
        let targetItem: PiPgmItem | undefined;
        if (request.entryId) {
          targetItem = state.playlist.find((i) => i.entryId === request.entryId);
        } else if (request.itemId) {
          targetItem = state.playlist.find((i) => i.id === request.itemId);
          if (!targetItem) {
            const libItem = this.library.get(request.itemId);
            if (libItem) {
              targetItem = this.newEntry(libItem);
              state.playlist.push(targetItem);
              this.persistLivePlaylist(state.id);
            }
          }
        } else if (request.itemIndex !== undefined && request.itemIndex >= 0 && request.itemIndex < state.playlist.length) {
          targetItem = state.playlist[request.itemIndex];
        }

        if (targetItem) {
          this.setActive(state, targetItem);
          state.currentStep = Math.max(
            0,
            Math.min(request.stepIndex ?? 0, Math.max(0, targetItem.steps.length - 1))
          );
          state.playbackState =
            targetItem.kind === "video" || targetItem.kind === "youtube" ? "playing" : "stopped";
        }
        break;
      }

      case "gotoStep": {
        if (activeItem) {
          const maxStep = Math.max(0, activeItem.steps.length - 1);
          state.currentStep = Math.max(0, Math.min(request.stepIndex ?? 0, maxStep));
        }
        break;
      }

      case "next": {
        if (!activeItem && state.playlist.length > 0) {
          const first = state.playlist[0]!;
          this.setActive(state, first);
          state.currentStep = 0;
          break;
        }
        if (activeItem) {
          if (state.currentStep + 1 < activeItem.steps.length) {
            state.currentStep += 1;
          } else if (advanceItemOnEnd && activeIndex + 1 < state.playlist.length) {
            const nextItem = state.playlist[activeIndex + 1]!;
            this.setActive(state, nextItem);
            state.currentStep = 0;
            state.playbackState =
              nextItem.kind === "video" || nextItem.kind === "youtube" ? "playing" : "stopped";
          }
        }
        break;
      }

      case "prev": {
        if (activeItem) {
          if (state.currentStep > 0) {
            state.currentStep -= 1;
          } else if (advanceItemOnEnd && activeIndex > 0) {
            const prevItem = state.playlist[activeIndex - 1]!;
            this.setActive(state, prevItem);
            state.currentStep = Math.max(0, prevItem.steps.length - 1);
          }
        }
        break;
      }

      case "play":
        state.playbackState = "playing";
        break;

      case "pause":
        state.playbackState = "paused";
        break;

      case "stop":
        state.playbackState = "stopped";
        break;

      case "restart":
        state.currentStep = 0;
        if (activeItem && (activeItem.kind === "video" || activeItem.kind === "youtube")) {
          state.playbackState = "playing";
        }
        break;
    }

    this.dropCarriedItem(state);
    const snapshot = this.toSnapshot(state);
    this.emitPipelineEvent(`control:${request.action}`, snapshot);

    if (
      this.autoSyncPiswitch &&
      (request.action === "next" ||
        request.action === "prev" ||
        request.action === "gotoStep" ||
        request.action === "gotoItem")
    ) {
      void this.syncToPiSwitch(pipelineId).catch(() => {});
    }

    if (!isSyncedCall && (request.sync || state.linked)) {
      for (const peer of this.pipelines.values()) {
        if (peer.id !== state.id && peer.linked) {
          this.control(peer.id, { ...request, sync: false }, true);
        }
      }
    }

    return snapshot;
  }

  addItemToPipeline(
    pipelineId: string,
    itemId: string,
    cueImmediately = false
  ): PiPgmPipelineSnapshot | undefined {
    const state = this.pipelines.get(pipelineId as PiPgmPipelineId);
    const item = this.library.get(itemId);
    if (!state || !item) return undefined;

    // Always a new entry: the same item may be in the playlist several times.
    const entry = this.newEntry(item);
    state.playlist.push(entry);
    this.persistLivePlaylist(state.id);

    if (cueImmediately || state.activeEntryId === null) {
      this.setActive(state, entry);
      state.currentStep = 0;
      state.playbackState = item.kind === "video" || item.kind === "youtube" ? "playing" : "stopped";
    }

    const snapshot = this.toSnapshot(state);
    this.emitPipelineEvent("playlist:add", snapshot);
    return snapshot;
  }

  /**
   * The library items meant for a day (their `useAt` overlaps it), in service order: hymns, then slide decks,
   * Canva, images, video, and last anything else (audio is left out: it plays through the audio route, not the
   * playlist). Within a group by the earliest time of the day, then by age. Changes nothing.
   */
  itemsForDate(date: string): PiPgmItem[] {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new UseAtError(`date must be YYYY-MM-DD: ${date}`);
    const [day] = useAtIntervals([date], USE_AT_ZONE);
    if (!day) throw new UseAtError(`date must be YYYY-MM-DD: ${date}`);
    const rank: Record<string, number> = { hymn: 0, pptx: 1, canva: 2, image: 3, video: 4, youtube: 4 };
    const hits: Array<{ item: PiPgmItem; from: number }> = [];
    for (const item of this.library.values()) {
      if (item.kind === "audio" || !item.useAt?.length) continue;
      const overlaps = useAtIntervals(item.useAt, USE_AT_ZONE).filter((i) => i.from <= day.to && i.to >= day.from);
      if (overlaps.length > 0) hits.push({ item, from: Math.min(...overlaps.map((i) => Math.max(i.from, day.from))) });
    }
    hits.sort(
      (a, b) =>
        (rank[a.item.kind] ?? 5) - (rank[b.item.kind] ?? 5) ||
        a.from - b.from ||
        a.item.createdAt.localeCompare(b.item.createdAt) ||
        a.item.id.localeCompare(b.item.id)
    );
    return hits.map((h) => structuredClone(h.item));
  }

  /** Removes the item carried over from a loaded playlist once the feed has moved off it. */
  private dropCarriedItem(state: PipelineInternalState): void {
    if (state.carriedItemId === null || state.activeEntryId === state.carriedItemId) return;
    const carried = state.carriedItemId;
    state.carriedItemId = null;
    state.playlist = state.playlist.filter((i) => i.entryId !== carried);
  }

  /** The library item a saved entry stands for: by id, else the newest item of the same kind and title, else a hymn of that number. */
  private resolveSavedItem(entry: SavedPlaylistItem): { item: PiPgmItem; by: "id" | "kindTitle" | "hymnNumber" } | null {
    const byId = entry.itemId ? this.library.get(entry.itemId) : undefined;
    if (byId) return { item: byId, by: "id" };
    const newest = (items: PiPgmItem[]): PiPgmItem | undefined =>
      items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
    const all = [...this.library.values()];
    if (entry.kind && entry.title) {
      const found = newest(all.filter((i) => i.kind === entry.kind && i.title === entry.title));
      if (found) return { item: found, by: "kindTitle" };
    }
    if (entry.hymn) {
      const number = String(entry.hymn.number).trim();
      const found = newest(all.filter((i) => i.kind === "hymn" && i.hymn?.hymnNumber.trim() === number));
      if (found) return { item: found, by: "hymnNumber" };
    }
    return null;
  }

  /**
   * Puts a saved playlist on a feed. `replace` makes it the whole playlist, `append` adds what is not there yet.
   * Whatever is on air is not touched: the active item and its step stay (when the new list does not hold the
   * active item it is carried first in the list until the feed moves on, so "next" goes to the first new item).
   * Nothing is cued when nothing was active. Entries that no longer resolve to a library item are reported in
   * `missing`; with `strict` any of them refuses the load and nothing changes.
   */
  loadSavedPlaylist(
    pipelineId: string,
    entries: readonly SavedPlaylistItem[],
    mode: "replace" | "append",
    options: { strict?: boolean } = {}
  ):
    | { error: "MISSING_ITEMS"; missing: LoadReport["missing"] }
    | { pipeline: PiPgmPipelineSnapshot; report: LoadReport }
    | undefined {
    const state = this.pipelines.get(pipelineId as PiPgmPipelineId);
    if (!state) return undefined;

    const resolved: LoadReport["resolved"] = [];
    const missing: LoadReport["missing"] = [];
    const duplicates: LoadReport["duplicates"] = [];
    const items: PiPgmItem[] = [];
    const skipped: LoadReport["skipped"] = [];
    entries.forEach((entry, index) => {
      if (entry.pause) {
        skipped.push({ index, reason: "pause-not-supported" });
        return;
      }
      const found = this.resolveSavedItem(entry);
      if (!found) {
        missing.push({
          index,
          itemId: entry.itemId ?? "",
          ...(entry.kind ? { kind: entry.kind } : {}),
          ...(entry.title ? { title: entry.title } : {}),
          ...(entry.hymn ? { hymn: entry.hymn } : {})
        });
        return;
      }
      items.push(this.newEntry(found.item));
      resolved.push({ index, itemId: found.item.id, by: found.by });
    });
    if (options.strict && missing.length > 0) return { error: "MISSING_ITEMS", missing };

    let keptActiveItemId: string | null = null;
    if (mode === "append") {
      state.playlist.push(...items);
    } else {
      const active = this.activeEntry(state);
      state.playlist = items;
      state.carriedItemId = null;
      if (active) {
        keptActiveItemId = active.id;
        const same = items.find((i) => i.id === active.id);
        if (same) {
          // The new list holds the item that is on air: that entry takes over, the step stays.
          this.setActive(state, same);
        } else {
          state.playlist.unshift(active);
          state.carriedItemId = active.entryId ?? null;
        }
      } else if (state.activeItemId !== null) {
        // The active item was not in the playlist (it was cued from the library): nothing to keep.
        this.setActive(state, null);
        state.currentStep = 0;
        state.playbackState = "stopped";
      }
    }
    this.persistLivePlaylist(state.id);

    const snapshot = this.toSnapshot(state);
    this.emitPipelineEvent("playlist:load", snapshot);
    return {
      pipeline: snapshot,
      report: { mode, resolved, missing, duplicates, skipped, keptActiveItemId, carriedActiveItem: state.carriedItemId !== null }
    };
  }

  /**
   * Replaces or reorders the playlist in one step. `ids` becomes the whole playlist, in that order. Each id is a
   * library item id (a new entry is made, so an item can be listed several times) or the entry id of an entry
   * already in the playlist (that entry is kept, which keeps what is on air). Entries left out are removed. Nothing
   * changes when an id is unknown. The entry on air and its step stay when it is still in the list (or, when it
   * was left out, an entry of the same item takes over); otherwise the first entry becomes active.
   */
  setPlaylistOrder(
    pipelineId: string,
    ids: readonly string[]
  ): PiPgmPipelineSnapshot | { error: "UNKNOWN_ITEMS"; ids: string[] } | undefined {
    const state = this.pipelines.get(pipelineId as PiPgmPipelineId);
    if (!state) return undefined;
    const entries = new Map(state.playlist.filter((i) => i.entryId).map((i) => [i.entryId as string, i]));
    const unknown = ids.filter((id) => !entries.has(id) && !this.library.has(id));
    if (unknown.length > 0) return { error: "UNKNOWN_ITEMS", ids: [...new Set(unknown)] };

    const used = new Set<string>();
    const next = ids.map((id) => {
      const existing = entries.get(id);
      if (existing && !used.has(id)) {
        used.add(id);
        return existing;
      }
      return this.newEntry(this.library.get(id) ?? existing!);
    });
    const previous = this.activeEntry(state);
    state.playlist = next;
    state.carriedItemId = null;
    this.persistLivePlaylist(state.id);
    if (previous && next.includes(previous)) {
      // still there, nothing to change
    } else if (previous && next.some((i) => i.id === previous.id)) {
      this.setActive(state, next.find((i) => i.id === previous.id));
    } else if (state.activeEntryId === null ? next.length > 0 : true) {
      this.setActive(state, next[0]);
      state.currentStep = 0;
      state.playbackState = "stopped";
    }

    const snapshot = this.toSnapshot(state);
    this.emitPipelineEvent("playlist:order", snapshot);
    return snapshot;
  }

  /** Removes one entry: `id` is an entry id, or an item id (then the first entry of that item). */
  removeItemFromPipeline(pipelineId: string, id: string): PiPgmPipelineSnapshot | undefined {
    const state = this.pipelines.get(pipelineId as PiPgmPipelineId);
    if (!state) return undefined;

    const index = state.playlist.findIndex((i) => i.entryId === id);
    const at = index >= 0 ? index : state.playlist.findIndex((i) => i.id === id);
    const removed = at >= 0 ? state.playlist[at] : undefined;
    if (removed) state.playlist.splice(at, 1);
    if (removed && state.carriedItemId === removed.entryId) state.carriedItemId = null;
    else if (removed) this.persistLivePlaylist(state.id);
    if (removed && state.activeEntryId === removed.entryId) {
      this.setActive(state, state.playlist[0]);
      state.currentStep = 0;
      state.playbackState = "stopped";
    }

    const snapshot = this.toSnapshot(state);
    this.emitPipelineEvent("playlist:remove", snapshot);
    return snapshot;
  }

  createHymnItem(input: CreateHymnItemInput): PiPgmItem {
    const id = this.nextId("hymn");
    const hymnNumber = input.hymnNumber?.trim() || "";
    const title = input.title.trim();
    const includeTitleSlide = input.includeTitleSlide ?? false;

    let stanzas: HymnStanza[] = [];
    if (input.stanzas && input.stanzas.length > 0) {
      stanzas = input.stanzas.map((s, idx) => ({
        stanzaNumber: String(s.stanzaNumber ?? idx + 1),
        lines: s.lines.map((l) => l.trim()).filter(Boolean),
        ...(s.refrain !== undefined ? { refrain: s.refrain } : {})
      }));
    } else if (input.rawText?.trim()) {
      stanzas = parseHymnStanzasFromText(input.rawText);
    }

    if (stanzas.length === 0) {
      stanzas = [{ stanzaNumber: "1", lines: [title] }];
    }

    const hymnData: HymnItemData = {
      hymnNumber,
      title,
      includeTitleSlide,
      stanzas
    };

    const item: PiPgmItem = {
      id,
      title: hymnNumber ? `${hymnNumber} ${title}` : title,
      kind: "hymn",
      createdAt: new Date().toISOString(),
      steps: buildHymnSteps(hymnData),
      hymn: hymnData
    };

    this.library.set(item.id, item);
    this.persistItem(item.id);

    if (input.targetPipelineId) {
      this.addItemToPipeline(input.targetPipelineId, item.id, input.cueImmediately ?? true);
    }

    return structuredClone(item);
  }

  createYouTubeItem(input: CreateYouTubeItemInput): PiPgmItem | null {
    const videoId = extractYouTubeVideoId(input.urlOrId);
    if (!videoId) return null;

    const id = this.nextId("yt");
    const title = input.title?.trim() || `YouTube (${videoId})`;
    const embedUrl = `https://www.youtube.com/embed/${encodeURIComponent(videoId)}`;
    const startSeconds = Math.max(0, Math.round(input.startSeconds ?? 0));
    const autoplay = input.autoplay ?? true;
    const loop = input.loop ?? false;

    const item: PiPgmItem = {
      id,
      title,
      kind: "youtube",
      createdAt: new Date().toISOString(),
      steps: [
        {
          stepIndex: 0,
          totalSteps: 1,
          label: title,
          subLabel: `YouTube ID: ${videoId}`,
          slideNumber: 1,
          previewText: [title, `https://youtu.be/${videoId}`],
          assetUrl: embedUrl
        }
      ],
      youtube: {
        videoId,
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
        embedUrl,
        startSeconds,
        ...(input.endSeconds !== undefined ? { endSeconds: input.endSeconds } : {}),
        autoplay,
        loop
      }
    };

    this.library.set(item.id, item);
    this.persistItem(item.id);

    if (input.targetPipelineId) {
      this.addItemToPipeline(input.targetPipelineId, item.id, input.cueImmediately ?? true);
    }

    return structuredClone(item);
  }

  createUploadedMediaItem(input: CreateUploadedMediaItemInput): PiPgmItem {
    const assetId = this.nextId("asset");
    const itemId = this.nextId(input.kind);
    const buffer = input.dataBase64 ? Buffer.from(input.dataBase64, "base64") : Buffer.alloc(0);
    const mimeType =
      input.mimeType?.trim() ||
      (input.kind === "video" ? "video/mp4" : input.kind === "audio" ? "audio/mpeg" : "image/png");
    const assetUrl = `/api/v1/pipgm/assets/${encodeURIComponent(assetId)}`;

    const asset: PiPgmAsset = {
      id: assetId,
      filename: input.filename,
      mimeType,
      kind: input.kind,
      sizeBytes: buffer.length,
      createdAt: new Date().toISOString(),
      url: assetUrl,
      data: buffer
    };
    this.assets.set(assetId, asset);

    const title = input.title?.trim() || input.filename;

    const item: PiPgmItem =
      input.kind === "audio"
        ? {
            id: itemId,
            title,
            kind: "audio",
            createdAt: asset.createdAt,
            steps: [
              {
                stepIndex: 0,
                totalSteps: 1,
                label: title,
                subLabel: input.filename,
                slideNumber: 1,
                previewText: [title],
                assetUrl
              }
            ],
            audio: {
              assetId,
              filename: input.filename,
              mimeType,
              assetUrl,
              ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
              loop: input.loop ?? false
            }
          }
        : input.kind === "video"
        ? {
            id: itemId,
            title,
            kind: "video",
            createdAt: asset.createdAt,
            steps: [
              {
                stepIndex: 0,
                totalSteps: 1,
                label: title,
                subLabel: input.filename,
                slideNumber: 1,
                previewText: [title],
                assetUrl
              }
            ],
            video: {
              assetId,
              filename: input.filename,
              mimeType,
              assetUrl,
              ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
              autoplay: input.autoplay ?? true,
              loop: input.loop ?? false
            }
          }
        : {
            id: itemId,
            title,
            kind: "image",
            createdAt: asset.createdAt,
            steps: [
              {
                stepIndex: 0,
                totalSteps: 1,
                label: title,
                subLabel: input.caption ?? input.filename,
                slideNumber: 1,
                previewText: [title, ...(input.caption ? [input.caption] : [])],
                assetUrl
              }
            ],
            image: {
              assetId,
              filename: input.filename,
              mimeType,
              assetUrl,
              fit: input.fit ?? "contain",
              ...(input.caption ? { caption: input.caption } : {})
            }
          };

    this.library.set(item.id, item);
    this.persistItem(item.id, assetId);

    if (input.targetPipelineId) {
      this.addItemToPipeline(input.targetPipelineId, item.id, input.cueImmediately ?? true);
    }

    return structuredClone(item);
  }

  createPptxItem(input: CreatePptxItemInput): PiPgmItem {
    const assetId = this.nextId("asset");
    const itemId = this.nextId("pptx");
    const buffer = input.dataBase64 ? Buffer.from(input.dataBase64, "base64") : undefined;
    const assetUrl = `/api/v1/pipgm/assets/${encodeURIComponent(assetId)}`;

    this.assets.set(assetId, {
      id: assetId,
      filename: input.filename,
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      kind: "pptx",
      sizeBytes: buffer?.length ?? 0,
      createdAt: new Date().toISOString(),
      url: assetUrl,
      ...(buffer ? { data: buffer } : {})
    });

    const pptxData = parsePptxPresentation({
      assetId,
      filename: input.filename,
      ...(buffer ? { buffer } : {}),
      ...(input.slides ? { slides: input.slides } : {}),
      animateBulletsByDefault: input.animateBulletsByDefault ?? true
    });

    const steps = buildPptxSteps(pptxData);
    const title = input.title?.trim() || input.filename.replace(/\.pptx$/i, "");

    const item: PiPgmItem = {
      id: itemId,
      title,
      kind: "pptx",
      createdAt: new Date().toISOString(),
      steps,
      pptx: pptxData
    };

    this.library.set(item.id, item);
    this.persistItem(item.id, assetId);

    if (input.targetPipelineId) {
      this.addItemToPipeline(input.targetPipelineId, item.id, input.cueImmediately ?? true);
    }

    return structuredClone(item);
  }


  controlCanvaPresentation(request: CanvaControlRequest): CanvaControlResult {
    const targetIds: PiPgmPipelineId[] = [];

    if (request.targetPipelineId === "all") {
      targetIds.push("PiPGM1", "PiPGM2", "PiPGM3");
    } else if (request.targetPipelineId && this.isValidPipelineId(request.targetPipelineId)) {
      targetIds.push(request.targetPipelineId as PiPgmPipelineId);
    } else if (request.designId) {
      for (const [pId, state] of this.pipelines.entries()) {
        if (!state.activeItemId) continue;
        const activeItem = this.activeEntry(state) || this.library.get(state.activeItemId);
        if (activeItem && activeItem.kind === "canva" && activeItem.canva?.designId === request.designId) {
          targetIds.push(pId);
        }
      }
    }

    if (targetIds.length === 0) {
      for (const [pId, state] of this.pipelines.entries()) {
        if (!state.activeItemId) continue;
        const activeItem = this.activeEntry(state) || this.library.get(state.activeItemId);
        if (activeItem && activeItem.kind === "canva") {
          targetIds.push(pId);
        }
      }
    }

    if (targetIds.length === 0) {
      targetIds.push("PiPGM1");
    }

    const updatedPipelines: PiPgmPipelineSnapshot[] = [];

    for (const pipelineId of targetIds) {
      const state = this.pipelines.get(pipelineId);
      if (!state) continue;

      switch (request.action) {
        case "ftb": {
          const res = this.setFadeToBlack(pipelineId, {
            ...(request.fadeToBlack !== undefined ? { fadeToBlack: request.fadeToBlack } : {}),
            toggle: request.ftbToggle ?? (request.fadeToBlack === undefined),
            ...(request.sync !== undefined ? { sync: request.sync } : {})
          });
          if (res) updatedPipelines.push(res);
          break;
        }

        case "mute": {
          const res = this.setAudio(pipelineId, {
            ...(request.audioEnabled !== undefined ? { audioEnabled: request.audioEnabled } : {}),
            toggle: request.muteToggle ?? (request.audioEnabled === undefined),
            ...(request.sync !== undefined ? { sync: request.sync } : {})
          });
          if (res) updatedPipelines.push(res);
          break;
        }

        case "gotoPage": {
          const stepIndex = Math.max(0, (request.pageNumber ?? 1) - 1);
          const res = this.control(pipelineId, {
            action: "gotoStep",
            stepIndex,
            ...(request.sync !== undefined ? { sync: request.sync } : {})
          });
          if (res) updatedPipelines.push(res);
          break;
        }

        case "gotoStep": {
          const res = this.control(pipelineId, {
            action: "gotoStep",
            stepIndex: request.stepIndex ?? 0,
            ...(request.sync !== undefined ? { sync: request.sync } : {})
          });
          if (res) updatedPipelines.push(res);
          break;
        }

        case "mode": {
          if (request.mode && state.activeItemId) {
            const activeItem = this.activeEntry(state) || this.library.get(state.activeItemId);
            if (activeItem && activeItem.kind === "canva" && activeItem.canva) {
              activeItem.canva.mode = request.mode;
              activeItem.steps = buildCanvaSteps(activeItem.canva);
            }
          }
          const snap = this.toSnapshot(state);
          this.emitPipelineEvent("config", snap);
          updatedPipelines.push(snap);
          break;
        }

        case "next":
        case "prev":
        case "play":
        case "pause":
        case "stop":
        case "restart": {
          const res = this.control(pipelineId, {
            action: request.action,
            ...(request.sync !== undefined ? { sync: request.sync } : {})
          });
          if (res) updatedPipelines.push(res);
          break;
        }
      }
    }

    return {
      success: true,
      action: request.action,
      pipelines: updatedPipelines
    };
  }

  async createOrPushCanvaItem(
    input: CanvaPluginPushInput,
    pushedFromCanvaApp = false
  ): Promise<PiPgmItem | null> {
    const canvaData = createCanvaItemData(input, pushedFromCanvaApp);
    if (!canvaData) return null;

    const itemId = this.nextId("canva");
    const steps = buildCanvaSteps(canvaData);

    const item: PiPgmItem = {
      id: itemId,
      title: canvaData.title,
      kind: "canva",
      createdAt: new Date().toISOString(),
      steps,
      canva: canvaData
    };
    const useAt = parseUseAt(input.useAt, USE_AT_ZONE);
    if (useAt.length > 0) item.useAt = useAt;

    this.library.set(item.id, item);
    this.persistItem(item.id);

    if (input.targetPipelineId && this.isValidPipelineId(input.targetPipelineId)) {
      if (input.orientation) {
        this.updatePipelineConfig(input.targetPipelineId, { orientation: input.orientation });
      }
      this.addItemToPipeline(input.targetPipelineId, item.id, input.cueImmediately ?? true);
    }

    if (input.autoExport) {
      const targetOrientation =
        input.orientation ??
        (input.targetPipelineId ? this.pipelines.get(input.targetPipelineId)?.orientation : undefined) ??
        "landscape";
      await this.exportCanvaItem(item.id, {
        format: input.exportFormat ?? "mp4",
        orientation: targetOrientation,
        switchToExportedMode: true
      });
    }

    return this.getLibraryItem(item.id) ?? null;
  }

  /** True when the item is stored in the library store (or there is no store, so nothing to wait for). */
  isItemSaved(itemId: string): boolean {
    return !this.libraryStore || (this.savedItems.has(itemId) && !this.unsaved.has(itemId));
  }

  /**
   * Replaces a Canva item's pages with delivered images (an export package): each becomes a library
   * asset, the item shows them as slides, and the files get a retention deadline in the store.
   */
  attachCanvaPages(
    itemId: string,
    pages: Array<{ pageNumber: number; filename: string; mimeType: string; data: Buffer }>
  ): PiPgmItem | "ITEM_NOT_FOUND" | "NOT_CANVA_ITEM" {
    const item = this.library.get(itemId);
    if (!item) return "ITEM_NOT_FOUND";
    if (item.kind !== "canva" || !item.canva) return "NOT_CANVA_ITEM";
    const oldIds = item.canva.pages.map((p) => p.assetId).filter((id): id is string => typeof id === "string");
    for (const id of oldIds) this.assets.delete(id);
    const createdAt = new Date().toISOString();
    const newIds: string[] = [];
    const canvaPages = pages.map((page) => {
      const assetId = this.nextId("asset");
      newIds.push(assetId);
      const url = `/api/v1/pipgm/assets/${encodeURIComponent(assetId)}`;
      this.assets.set(assetId, {
        id: assetId,
        filename: page.filename,
        mimeType: page.mimeType,
        kind: "canva_export",
        sizeBytes: page.data.length,
        createdAt,
        url,
        data: page.data
      });
      return { pageNumber: page.pageNumber, title: page.filename.replace(/\.[^.]+$/, ""), assetUrl: url, assetId };
    });
    item.canva.pages = canvaPages;
    item.canva.pageCount = canvaPages.length;
    item.canva.mode = "exported_slides";
    item.canva.exportJob = {
      jobId: `canva-package-${this.now()}`,
      status: "completed",
      format: "png",
      quality: item.canva.exportJob.quality,
      downloadUrls: [],
      localAssetUrls: canvaPages.map((p) => p.assetUrl),
      updatedAt: createdAt,
      error: null
    };
    item.steps = buildCanvaSteps(item.canva);
    this.syncLibraryItemToPlaylists(item);
    const expiresAt = this.canvaRetentionDays > 0 ? new Date(this.now() + this.canvaRetentionDays * 86_400_000).toISOString() : undefined;
    this.savedItems.delete(itemId);
    this.persistItem(itemId, newIds, expiresAt);
    for (const id of oldIds) void this.libraryStore?.removeAssets([id]).catch(() => undefined);
    return structuredClone(item);
  }

  async exportCanvaItem(
    itemId: string,
    options: {
      format?: "mp4" | "png";
      orientation?: PiPgmOrientation;
      switchToExportedMode?: boolean;
    } = {}
  ): Promise<PiPgmItem | null> {
    const item = this.library.get(itemId);
    if (!item || item.kind !== "canva" || !item.canva) return null;

    const format = options.format ?? "mp4";
    const orientation = options.orientation ?? "landscape";
    const exportJob = await runCanvaConnectExport(
      itemId,
      item.canva,
      format,
      orientation,
      this.canvaConfig
    );

    item.canva.exportJob = exportJob;
    if (exportJob.status === "completed") {
      item.canva.pages = item.canva.pages.map((page, idx) => ({
        ...page,
        ...(exportJob.localAssetUrls[idx] ? { assetUrl: exportJob.localAssetUrls[idx] } : {})
      }));
      if (options.switchToExportedMode !== false) {
        const nextMode: CanvaRenderMode = format === "png" ? "exported_slides" : "exported_mp4";
        item.canva.mode = nextMode;
      }
    }

    item.steps = buildCanvaSteps(item.canva);
    this.syncLibraryItemToPlaylists(item);
    this.persistItem(itemId);
    return structuredClone(item);
  }

  private syncLibraryItemToPlaylists(updatedItem: PiPgmItem): void {
    for (const state of this.pipelines.values()) {
      let changed = false;
      state.playlist = state.playlist.map((entry) => {
        if (entry.id !== updatedItem.id) return entry;
        changed = true;
        return { ...structuredClone(updatedItem), ...(entry.entryId ? { entryId: entry.entryId } : {}) };
      });
      if (changed) this.emitPipelineEvent("item:updated", this.toSnapshot(state));
    }
  }

  private buildMobileAlert(
    state: PipelineInternalState,
    activeItem: PiPgmItem | null,
    currentStepDetail: PiPgmPipelineSnapshot["currentStepDetail"]
  ): PiPgmMobileAlert {
    let signCode: PiPgmMobileSignCode = "NORMAL";
    let bannerText: string | null = null;

    if (state.fadeToBlack && state.audioEnabled) {
      signCode = "FTB_AND_SOUND_ON";
      bannerText = "FADED TO BLACK (SOUND STILL ARMED)";
    } else if (state.fadeToBlack) {
      signCode = "FADED_TO_BLACK";
      bannerText = "OUTPUT FADED TO BLACK — LIVE SCREEN IS DARK";
    } else if (state.audioEnabled) {
      signCode = "SOUND_ON_AIR";
      bannerText = "SOUND ENABLED (UNMUTED ON AIR)";
    }

    const cuedSummary = activeItem
      ? `${activeItem.title}${currentStepDetail ? ` • ${currentStepDetail.label}` : ""}`
      : null;

    return {
      fadeToBlackActive: state.fadeToBlack,
      audioArmed: state.audioEnabled,
      signCode,
      bannerText,
      ghostPreviewAvailable: Boolean(state.fadeToBlack && activeItem),
      cuedSummary
    };
  }

  private toSnapshot(state: PipelineInternalState): PiPgmPipelineSnapshot {
    this.expireArming(state);
    const activeIndex = state.playlist.findIndex((i) => i.entryId === state.activeEntryId);
    const activeItem = activeIndex >= 0 ? state.playlist[activeIndex] ?? null : null;
    const totalSteps = activeItem ? activeItem.steps.length : 0;
    const currentStepDetail =
      activeItem && activeItem.steps[state.currentStep]
        ? structuredClone(activeItem.steps[state.currentStep]!)
        : null;
    const nextStepDetail =
      activeItem && activeItem.steps[state.currentStep + 1]
        ? structuredClone(activeItem.steps[state.currentStep + 1]!)
        : null;

    let pipelineState: PiPgmPipelineSnapshot["state"] = "idle";
    if (state.fadeToBlack) {
      pipelineState = "blackout";
    } else if (activeItem || state.stream.state === "running") {
      pipelineState = "live";
    }

    return {
      id: state.id,
      label: state.label,
      hidden: state.hidden,
      orientation: state.orientation,
      resolution: getResolutionForOrientation(state.orientation),
      state: pipelineState,
      fadeToBlack: state.fadeToBlack,
      fadeDurationMs: state.fadeDurationMs,
      keyColor: state.keyColor,
      audioEnabled: state.audioEnabled,
      audioArmedUntil: state.audioArmedUntil === null ? null : new Date(state.audioArmedUntil).toISOString(),
      volume: state.volume,
      maxVolume: this.audioMaxVolume,
      effectiveVolume: Math.min(state.volume, this.audioMaxVolume),
      audioTrack: state.audioTrack ? { ...state.audioTrack } : null,
      basicImageItemId: state.basicImageItemId,
      basicImageUrl: state.basicImageItemId
        ? this.library.get(state.basicImageItemId)?.image?.assetUrl ?? null
        : null,
      linked: state.linked,
      activeItemId: state.activeItemId,
      activeEntryId: state.activeEntryId,
      activeItemIndex: activeIndex,
      currentStep: state.currentStep,
      totalSteps,
      currentStepDetail,
      nextStepDetail,
      playbackState: state.playbackState,
      stageUrl: `/pipgm/${encodeURIComponent(state.id)}/stage`,
      slideFeed: buildSlideFeed(state.id, getResolutionForOrientation(state.orientation), totalSteps > 0),
      mobileAlert: this.buildMobileAlert(state, activeItem, currentStepDetail),
      stream: { ...state.stream },
      playlist: state.playlist.map((item) => structuredClone(item))
    };
  }


  getPiSwitchClient(): PiSwitchClient | undefined {
    return this.piswitchClient;
  }

  async syncToPiSwitch(pipelineId: string): Promise<SlideAdvanceResult | null> {
    if (!this.piswitchClient) return null;
    const pipeline = this.getPipeline(pipelineId);
    if (!pipeline) return null;

    try {
      const advanceResult = await this.piswitchClient.advanceSlide();

      let png: Buffer | null = null;
      if (this.stepImages && pipeline.activeItemId && !pipeline.fadeToBlack) {
        png =
          (await this.stepImages.lookupVariant(pipeline, "rgba-left")) ??
          (await this.stepImages.lookupVariant(pipeline, "rgba-right")) ??
          (await this.stepImages.lookup(pipeline));
      }
      if (!png && this.frameRenderer) {
        try {
          png = await this.frameRenderer({
            html: renderPiPgmStageHtml(pipeline, { transparent: true, silent: true }),
            width: pipeline.resolution.width,
            height: pipeline.resolution.height,
            transparent: true
          });
        } catch {
          // frame rendering failed
        }
      }
      if (png) {
        try {
          const slideName = `pipgm-${pipeline.id}-step${pipeline.currentStep}`;
          await this.piswitchClient.uploadStill(advanceResult.activeSlot, png, slideName, "slides");
        } catch {
          // upload failed, but buffer advanced
        }
      }

      this.emitPipelineEvent("piswitch:synced", pipeline);
      return advanceResult;
    } catch {
      return null;
    }
  }

  private emitPipelineEvent(action: string, snapshot: PiPgmPipelineSnapshot): void {
    this.eventBroker?.emit({
      type: "pipgm",
      data: {
        action,
        pipeline: snapshot
      }
    });
  }
}
