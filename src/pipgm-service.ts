import type { PiMatrixEventBroker } from "../events.js";
import type { ManagedStreamSnapshot } from "../stream-supervisor.js";
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
  extractYouTubeVideoId,
  getResolutionForOrientation,
  parseHymnStanzasFromText,
  pipgmPipelineDefinitions,
  type CanvaRenderMode,
  type HymnItemData,
  type HymnStanza,
  type PiPgmAsset,
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
import { buildPptxSteps, parsePptxPresentation } from "./pptx-adapter.js";

interface PipelineInternalState {
  id: PiPgmPipelineId;
  label: string;
  hidden: boolean;
  orientation: PiPgmOrientation;
  fadeToBlack: boolean;
  fadeDurationMs: number;
  audioEnabled: boolean;
  volume: number;
  linked: boolean;
  activeItemId: string | null;
  currentStep: number;
  playbackState: PiPgmPlaybackState;
  playlist: PiPgmItem[];
  stream: ManagedStreamSnapshot;
}

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
  kind: "video" | "image";
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
}

export class PiPgmService {
  private readonly pipelines = new Map<PiPgmPipelineId, PipelineInternalState>();
  private readonly library = new Map<string, PiPgmItem>();
  private readonly assets = new Map<string, PiPgmAsset>();
  private readonly eventBroker?: PiMatrixEventBroker | undefined;
  private readonly canvaConfig: CanvaConnectConfig;
  private idCounter = 1;

  constructor(options: PiPgmServiceOptions = {}) {
    this.eventBroker = options.eventBroker;
    this.canvaConfig = options.canvaConfig ?? {};

    for (const def of pipgmPipelineDefinitions) {
      this.pipelines.set(def.id, {
        id: def.id,
        label: def.label,
        hidden: def.defaultHidden,
        orientation: def.defaultOrientation,
        fadeToBlack: false,
        fadeDurationMs: 500,
        audioEnabled: false, // Muted by default ("usually we work muted, but sometimes sound is required")
        volume: 100,
        linked: false,
        activeItemId: null,
        currentStep: 0,
        playbackState: "stopped",
        playlist: [],
        stream: {
          state: "disabled",
          jobId: null,
          attempt: 0,
          lastError: null,
          stderrTail: null
        }
      });
    }
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
    options: { audioEnabled?: boolean; toggle?: boolean; volume?: number; sync?: boolean },
    isSyncedCall = false
  ): PiPgmPipelineSnapshot | undefined {
    const state = this.pipelines.get(pipelineId as PiPgmPipelineId);
    if (!state) return undefined;

    if (options.toggle) {
      state.audioEnabled = !state.audioEnabled;
    } else if (options.audioEnabled !== undefined) {
      state.audioEnabled = options.audioEnabled;
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
              volume: state.volume
            },
            true
          );
        }
      }
    }

    return snapshot;
  }

  control(
    pipelineId: string,
    request: PiPgmControlRequest,
    isSyncedCall = false
  ): PiPgmPipelineSnapshot | undefined {
    const state = this.pipelines.get(pipelineId as PiPgmPipelineId);
    if (!state) return undefined;

    const advanceItemOnEnd = request.advanceItemOnEnd ?? false;
    const activeIndex = state.playlist.findIndex((i) => i.id === state.activeItemId);
    const activeItem = activeIndex >= 0 ? state.playlist[activeIndex] : undefined;

    switch (request.action) {
      case "gotoItem": {
        let targetItem: PiPgmItem | undefined;
        if (request.itemId) {
          targetItem = state.playlist.find((i) => i.id === request.itemId);
          if (!targetItem) {
            const libItem = this.library.get(request.itemId);
            if (libItem) {
              targetItem = structuredClone(libItem);
              state.playlist.push(targetItem);
            }
          }
        } else if (request.itemIndex !== undefined && request.itemIndex >= 0 && request.itemIndex < state.playlist.length) {
          targetItem = state.playlist[request.itemIndex];
        }

        if (targetItem) {
          state.activeItemId = targetItem.id;
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
          state.activeItemId = first.id;
          state.currentStep = 0;
          break;
        }
        if (activeItem) {
          if (state.currentStep + 1 < activeItem.steps.length) {
            state.currentStep += 1;
          } else if (advanceItemOnEnd && activeIndex + 1 < state.playlist.length) {
            const nextItem = state.playlist[activeIndex + 1]!;
            state.activeItemId = nextItem.id;
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
            state.activeItemId = prevItem.id;
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

    const snapshot = this.toSnapshot(state);
    this.emitPipelineEvent(`control:${request.action}`, snapshot);

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

    const existingIdx = state.playlist.findIndex((i) => i.id === item.id);
    if (existingIdx < 0) {
      state.playlist.push(structuredClone(item));
    } else {
      state.playlist[existingIdx] = structuredClone(item);
    }

    if (cueImmediately || state.activeItemId === null) {
      state.activeItemId = item.id;
      state.currentStep = 0;
      state.playbackState = item.kind === "video" || item.kind === "youtube" ? "playing" : "stopped";
    }

    const snapshot = this.toSnapshot(state);
    this.emitPipelineEvent("playlist:add", snapshot);
    return snapshot;
  }

  removeItemFromPipeline(pipelineId: string, itemId: string): PiPgmPipelineSnapshot | undefined {
    const state = this.pipelines.get(pipelineId as PiPgmPipelineId);
    if (!state) return undefined;

    state.playlist = state.playlist.filter((i) => i.id !== itemId);
    if (state.activeItemId === itemId) {
      state.activeItemId = state.playlist[0]?.id ?? null;
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
      (input.kind === "video" ? "video/mp4" : "image/png");
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
      input.kind === "video"
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
        const activeItem = state.playlist.find((i) => i.id === state.activeItemId) || this.library.get(state.activeItemId);
        if (activeItem && activeItem.kind === "canva" && activeItem.canva?.designId === request.designId) {
          targetIds.push(pId);
        }
      }
    }

    if (targetIds.length === 0) {
      for (const [pId, state] of this.pipelines.entries()) {
        if (!state.activeItemId) continue;
        const activeItem = state.playlist.find((i) => i.id === state.activeItemId) || this.library.get(state.activeItemId);
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
            const activeItem = state.playlist.find((i) => i.id === state.activeItemId) || this.library.get(state.activeItemId);
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

    this.library.set(item.id, item);

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
    return structuredClone(item);
  }

  private syncLibraryItemToPlaylists(updatedItem: PiPgmItem): void {
    for (const state of this.pipelines.values()) {
      const idx = state.playlist.findIndex((i) => i.id === updatedItem.id);
      if (idx >= 0) {
        state.playlist[idx] = structuredClone(updatedItem);
        this.emitPipelineEvent("item:updated", this.toSnapshot(state));
      }
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
    const activeIndex = state.playlist.findIndex((i) => i.id === state.activeItemId);
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
      audioEnabled: state.audioEnabled,
      volume: state.volume,
      linked: state.linked,
      activeItemId: state.activeItemId,
      activeItemIndex: activeIndex,
      currentStep: state.currentStep,
      totalSteps,
      currentStepDetail,
      nextStepDetail,
      playbackState: state.playbackState,
      stageUrl: `/pipgm/${encodeURIComponent(state.id)}/stage`,
      mobileAlert: this.buildMobileAlert(state, activeItem, currentStepDetail),
      stream: { ...state.stream },
      playlist: state.playlist.map((item) => structuredClone(item))
    };
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
