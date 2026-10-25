import type { ManagedStreamSnapshot } from "../stream-supervisor.js";

export const pipgmPipelineDefinitions = [
  { id: "PiPGM1", label: "Pi Programme 1", defaultOrientation: "portrait" as const, defaultHidden: false },
  { id: "PiPGM2", label: "Pi Programme 2", defaultOrientation: "landscape" as const, defaultHidden: false },
  { id: "PiPGM3", label: "Pi Programme 3", defaultOrientation: "landscape" as const, defaultHidden: true }
] as const;

export type PiPgmPipelineId = typeof pipgmPipelineDefinitions[number]["id"];
export type PiPgmOrientation = "landscape" | "portrait";
export type PiPgmPipelineState = "idle" | "live" | "blackout" | "starting" | "degraded" | "failed";
export type PiPgmPlaybackState = "playing" | "paused" | "stopped";

export type PiPgmItemKind =
  | "pptx"
  | "canva"
  | "youtube"
  | "video"
  | "image"
  | "hymn";

export interface PiPgmResolution {
  width: number;
  height: number;
}

export function getResolutionForOrientation(orientation: PiPgmOrientation): PiPgmResolution {
  return orientation === "portrait"
    ? { width: 1080, height: 1920 }
    : { width: 1920, height: 1080 };
}

export type PptxAnimationEffect =
  | "initial"
  | "appear"
  | "fade"
  | "wipe"
  | "fly"
  | "zoom"
  | "morph";

export interface PptxAnimationBuild {
  buildIndex: number;
  effect: PptxAnimationEffect;
  targetText?: string;
  durationMs: number;
}

export interface PptxSlide {
  slideNumber: number;
  title: string;
  bullets: string[];
  notes?: string;
  backgroundUrl?: string;
  builds: PptxAnimationBuild[];
}

export interface PptxItemData {
  assetId: string;
  filename: string;
  slideCount: number;
  slides: PptxSlide[];
}

export type CanvaRenderMode = "embed" | "exported_mp4" | "exported_slides";
export type CanvaExportStatus = "idle" | "pending" | "in_progress" | "completed" | "failed";

export interface CanvaExportJob {
  jobId: string | null;
  status: CanvaExportStatus;
  format: "mp4" | "png";
  quality: "1080p" | "1080p_vertical";
  downloadUrls: string[];
  localAssetUrls: string[];
  updatedAt: string;
  error?: string | null;
}

export interface CanvaPage {
  pageNumber: number;
  title?: string;
  durationMs?: number;
  assetUrl?: string;
}

export interface CanvaItemData {
  designId: string;
  title: string;
  mode: CanvaRenderMode;
  embedUrl: string;
  editUrl?: string;
  pageCount: number;
  pages: CanvaPage[];
  pushedFromCanvaApp: boolean;
  exportJob: CanvaExportJob;
}

export interface YouTubeItemData {
  videoId: string;
  url: string;
  embedUrl: string;
  startSeconds: number;
  endSeconds?: number;
  autoplay: boolean;
  loop: boolean;
}

export interface VideoItemData {
  assetId: string;
  filename: string;
  mimeType: string;
  assetUrl: string;
  durationMs?: number;
  autoplay: boolean;
  loop: boolean;
}

export interface ImageItemData {
  assetId: string;
  filename: string;
  mimeType: string;
  assetUrl: string;
  fit: "contain" | "cover";
  caption?: string;
}

export interface HymnStanza {
  stanzaNumber: string;
  lines: string[];
  refrain?: boolean;
}

export interface HymnItemData {
  hymnNumber: string;
  title: string;
  includeTitleSlide: boolean;
  stanzas: HymnStanza[];
}

export interface PiPgmStepDescriptor {
  stepIndex: number;
  totalSteps: number;
  label: string;
  subLabel?: string;
  slideNumber?: number;
  buildIndex?: number;
  effect?: string;
  previewText?: string[];
  assetUrl?: string;
}

export interface PiPgmItem {
  id: string;
  title: string;
  kind: PiPgmItemKind;
  createdAt: string;
  steps: PiPgmStepDescriptor[];
  pptx?: PptxItemData;
  canva?: CanvaItemData;
  youtube?: YouTubeItemData;
  video?: VideoItemData;
  image?: ImageItemData;
  hymn?: HymnItemData;
}

export type PiPgmMobileSignCode =
  | "NORMAL"
  | "FADED_TO_BLACK"
  | "SOUND_ON_AIR"
  | "FTB_AND_SOUND_ON";

export interface PiPgmMobileAlert {
  fadeToBlackActive: boolean;
  audioArmed: boolean;
  signCode: PiPgmMobileSignCode;
  bannerText: string | null;
  ghostPreviewAvailable: boolean;
  cuedSummary: string | null;
}

export interface PiPgmPipelineSnapshot {
  id: PiPgmPipelineId;
  label: string;
  hidden: boolean;
  orientation: PiPgmOrientation;
  resolution: PiPgmResolution;
  state: PiPgmPipelineState;
  fadeToBlack: boolean;
  fadeDurationMs: number;
  audioEnabled: boolean;
  volume: number;
  linked: boolean;
  activeItemId: string | null;
  activeItemIndex: number;
  currentStep: number;
  totalSteps: number;
  currentStepDetail: PiPgmStepDescriptor | null;
  nextStepDetail: PiPgmStepDescriptor | null;
  playbackState: PiPgmPlaybackState;
  stageUrl: string;
  mobileAlert: PiPgmMobileAlert;
  stream: ManagedStreamSnapshot;
  playlist: PiPgmItem[];
}

export type PiPgmControlAction =
  | "next"
  | "prev"
  | "gotoStep"
  | "gotoItem"
  | "play"
  | "pause"
  | "stop"
  | "restart";

export interface PiPgmControlRequest {
  action: PiPgmControlAction;
  stepIndex?: number;
  itemId?: string;
  itemIndex?: number;
  advanceItemOnEnd?: boolean;
  sync?: boolean;
}

export interface PiPgmAsset {
  id: string;
  filename: string;
  mimeType: string;
  kind: "pptx" | "video" | "image" | "canva_export";
  sizeBytes: number;
  createdAt: string;
  url: string;
  data?: Buffer;
}

export function extractYouTubeVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname === "youtu.be") {
      const id = parsed.pathname.replace(/^\//, "").split("/")[0];
      return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (parsed.hostname.endsWith("youtube.com") || parsed.hostname.endsWith("youtube-nocookie.com")) {
      const v = parsed.searchParams.get("v");
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
      const parts = parsed.pathname.split("/").filter(Boolean);
      if ((parts[0] === "embed" || parts[0] === "shorts" || parts[0] === "live") && parts[1]) {
        return /^[a-zA-Z0-9_-]{11}$/.test(parts[1]) ? parts[1] : null;
      }
    }
  } catch {
    // Not a URL
  }
  return null;
}

export function parseHymnStanzasFromText(rawText: string): HymnStanza[] {
  const blocks = rawText
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  return blocks.map((block, idx) => {
    const rawLines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    let stanzaNumber = String(idx + 1);
    let lines = rawLines;

    // Detect leading stanza number like "1." or "1)" on its own line or prefixing first line
    if (rawLines.length > 1 && /^(\d+)[.)]?$/.test(rawLines[0]!)) {
      stanzaNumber = rawLines[0]!.replace(/[.)]$/, "");
      lines = rawLines.slice(1);
    } else if (rawLines[0]) {
      const prefixMatch = /^(\d+)[.)]\s+(.+)$/.exec(rawLines[0]);
      if (prefixMatch && prefixMatch[1] && prefixMatch[2]) {
        stanzaNumber = prefixMatch[1];
        lines = [prefixMatch[2], ...rawLines.slice(1)];
      }
    }

    return {
      stanzaNumber,
      lines
    };
  });
}

export function buildHymnSteps(data: HymnItemData): PiPgmStepDescriptor[] {
  const steps: PiPgmStepDescriptor[] = [];
  const totalSteps = data.stanzas.length + (data.includeTitleSlide ? 1 : 0);

  if (data.includeTitleSlide) {
    steps.push({
      stepIndex: 0,
      totalSteps,
      label: `${data.hymnNumber} — ${data.title}`,
      subLabel: "Title Slide",
      slideNumber: 0,
      previewText: [data.hymnNumber, data.title]
    });
  }

  data.stanzas.forEach((stanza, index) => {
    const stepIndex = steps.length;
    steps.push({
      stepIndex,
      totalSteps,
      label: `Stanza ${stanza.stanzaNumber} (${index + 1}/${data.stanzas.length})`,
      subLabel: `${data.hymnNumber} ${data.title}`.trim(),
      slideNumber: index + 1,
      previewText: stanza.lines
    });
  });

  return steps;
}
