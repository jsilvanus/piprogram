import type {
  CanvaExportJob,
  CanvaItemData,
  CanvaPage,
  CanvaRenderMode,
  PiPgmOrientation,
  PiPgmPipelineId,
  PiPgmStepDescriptor
} from "./pipgm-model.js";

export interface CanvaPluginPushInput {
  designId?: string;
  title?: string;
  embedUrl?: string;
  viewUrl?: string;
  editUrl?: string;
  pageCount?: number;
  pages?: Array<{
    pageNumber?: number;
    title?: string;
    durationMs?: number;
    assetUrl?: string;
  }>;
  exportUrls?: string[];
  exportFormat?: "mp4" | "png";
  mode?: CanvaRenderMode;
  autoExport?: boolean;
  targetPipelineId?: PiPgmPipelineId;
  cueImmediately?: boolean;
  orientation?: PiPgmOrientation;
}

export function normalizeCanvaDesign(input: {
  designId?: string;
  url?: string;
  embedUrl?: string;
}): { designId: string; embedUrl: string } | null {
  const rawUrl = input.embedUrl?.trim() || input.url?.trim();
  let designId = input.designId?.trim() || "";

  if (!designId && rawUrl) {
    const match = /\/design\/([a-zA-Z0-9_-]+)/.exec(rawUrl);
    if (match?.[1]) {
      designId = match[1];
    }
  }

  if (!designId && rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        designId = `custom-${Buffer.from(parsed.pathname).toString("hex").slice(0, 10) || "design"}`;
        const embedUrl = rawUrl.includes("embed") ? rawUrl : `${rawUrl.replace(/\/$/, "")}${rawUrl.includes("?") ? "&" : "?"}embed`;
        return { designId, embedUrl };
      }
    } catch {
      return null;
    }
  }

  if (!designId || !/^[a-zA-Z0-9_-]{3,64}$/.test(designId)) {
    return null;
  }

  let embedUrl = `https://www.canva.com/design/${encodeURIComponent(designId)}/view?embed`;
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        if (!parsed.searchParams.has("embed")) {
          parsed.searchParams.set("embed", "");
        }
        embedUrl = parsed.toString().replace(/=&/, "&").replace(/=$/, "");
      }
    } catch {
      // Keep canonical Canva embed URL
    }
  }

  return { designId, embedUrl };
}

export function createCanvaItemData(
  input: CanvaPluginPushInput,
  pushedFromCanvaApp: boolean
): CanvaItemData | null {
  const normalized = normalizeCanvaDesign({
    ...(input.designId ? { designId: input.designId } : {}),
    ...(input.embedUrl ? { embedUrl: input.embedUrl } : {}),
    ...(input.viewUrl ? { url: input.viewUrl } : {})
  });
  if (!normalized) return null;

  const exportUrls = (input.exportUrls ?? []).filter((u) => typeof u === "string" && u.trim().length > 0);
  const explicitPages = input.pages ?? [];
  const pageCount = Math.max(
    1,
    Math.min(
      200,
      Number.isInteger(input.pageCount) && (input.pageCount ?? 0) > 0
        ? input.pageCount!
        : Math.max(explicitPages.length, exportUrls.length, 1)
    )
  );

  const pages: CanvaPage[] = [];
  for (let i = 0; i < pageCount; i += 1) {
    const explicit = explicitPages[i];
    const assetUrl = explicit?.assetUrl ?? exportUrls[i];
    pages.push({
      pageNumber: explicit?.pageNumber ?? i + 1,
      title: explicit?.title ?? `Page ${i + 1}`,
      ...(explicit?.durationMs !== undefined ? { durationMs: explicit.durationMs } : {}),
      ...(assetUrl ? { assetUrl } : {})
    });
  }

  const format: "mp4" | "png" = input.exportFormat === "png" ? "png" : "mp4";
  const quality = input.orientation === "portrait" ? "1080p_vertical" : "1080p";

  let mode: CanvaRenderMode = input.mode ?? "embed";
  if (!input.mode && exportUrls.length > 0) {
    mode = format === "png" ? "exported_slides" : "exported_mp4";
  }

  const exportJob: CanvaExportJob = {
    jobId: exportUrls.length > 0 ? `canva-plugin-export-${Date.now()}` : null,
    status: exportUrls.length > 0 ? "completed" : "idle",
    format,
    quality,
    downloadUrls: exportUrls,
    localAssetUrls: exportUrls,
    updatedAt: new Date().toISOString(),
    error: null
  };

  return {
    designId: normalized.designId,
    title: input.title?.trim() || `Canva ${normalized.designId}`,
    mode,
    embedUrl: normalized.embedUrl,
    ...(input.editUrl ? { editUrl: input.editUrl } : {}),
    pageCount,
    pages,
    pushedFromCanvaApp,
    exportJob
  };
}

export function buildCanvaSteps(data: CanvaItemData): PiPgmStepDescriptor[] {
  const totalSteps = Math.max(1, data.pages.length);
  return data.pages.map((page, index) => {
    const assetUrl = page.assetUrl ?? data.exportJob.localAssetUrls[index] ?? data.embedUrl;
    return {
      stepIndex: index,
      totalSteps,
      label: `Page ${page.pageNumber} (${index + 1}/${totalSteps})`,
      subLabel: page.title ?? data.title,
      slideNumber: page.pageNumber,
      previewText: [data.title, page.title ?? `Page ${page.pageNumber}`],
      assetUrl
    };
  });
}

export interface CanvaConnectConfig {
  apiBaseUrl?: string | undefined;
  accessToken?: string | undefined;
  fetchImpl?: typeof fetch;
}

export async function runCanvaConnectExport(
  itemId: string,
  canva: CanvaItemData,
  format: "mp4" | "png",
  orientation: PiPgmOrientation,
  config: CanvaConnectConfig = {}
): Promise<CanvaExportJob> {
  const fetchFn = config.fetchImpl ?? fetch;
  const quality: "1080p" | "1080p_vertical" = orientation === "portrait" ? "1080p_vertical" : "1080p";
  const now = new Date().toISOString();

  // If Canva Connect API credentials are configured, call Canva's REST export API
  if (config.accessToken && config.apiBaseUrl) {
    try {
      const formatPayload = format === "mp4"
        ? { type: "mp4", quality: orientation === "portrait" ? "vertical_1080p" : "horizontal_1080p" }
        : { type: "png" };

      const response = await fetchFn(`${config.apiBaseUrl.replace(/\/$/, "")}/v1/exports`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.accessToken}`,
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify({
          design_id: canva.designId,
          format: formatPayload
        }),
        signal: AbortSignal.timeout(5000)
      });

      if (!response.ok) {
        return {
          jobId: null,
          status: "failed",
          format,
          quality,
          downloadUrls: [],
          localAssetUrls: [],
          updatedAt: now,
          error: `Canva Connect API returned HTTP ${response.status}`
        };
      }

      const payload = (await response.json()) as {
        job?: { id?: string; status?: string; urls?: string[] };
      };
      const jobId = payload.job?.id ?? `canva-job-${Date.now()}`;
      const urls = Array.isArray(payload.job?.urls) ? payload.job.urls : [];
      const status = payload.job?.status === "success" || urls.length > 0 ? "completed" : "in_progress";
      const localUrls = urls.map((_, idx) => `/api/v1/pipgm/items/${encodeURIComponent(itemId)}/canva/page/${idx + 1}.${format}`);

      return {
        jobId,
        status,
        format,
        quality,
        downloadUrls: urls,
        localAssetUrls: status === "completed" ? localUrls : [],
        updatedAt: now,
        error: null
      };
    } catch (err) {
      return {
        jobId: null,
        status: "failed",
        format,
        quality,
        downloadUrls: [],
        localAssetUrls: [],
        updatedAt: now,
        error: err instanceof Error ? err.message : "Canva Connect export failed"
      };
    }
  }

  // Local / Simulated Canva export generation for offline Pi staging and development
  const jobId = `sim-canva-export-${canva.designId}-${Date.now()}`;
  const ext = format === "mp4" ? "mp4" : "png";
  const localAssetUrls = canva.pages.map(
    (p) => `/api/v1/pipgm/items/${encodeURIComponent(itemId)}/canva/page/${p.pageNumber}.${ext}`
  );
  const downloadUrls = canva.pages.map(
    (p) => `https://export-download.canva.com/${encodeURIComponent(canva.designId)}/page-${p.pageNumber}.${ext}`
  );

  return {
    jobId,
    status: "completed",
    format,
    quality,
    downloadUrls,
    localAssetUrls,
    updatedAt: now,
    error: null
  };
}

export interface CanvaControlRequest {
  designId?: string;
  targetPipelineId?: string;
  action:
    | "next"
    | "prev"
    | "gotoPage"
    | "gotoStep"
    | "ftb"
    | "mute"
    | "play"
    | "pause"
    | "stop"
    | "restart"
    | "mode";
  pageNumber?: number;
  stepIndex?: number;
  fadeToBlack?: boolean;
  ftbToggle?: boolean;
  audioEnabled?: boolean;
  muteToggle?: boolean;
  mode?: CanvaRenderMode;
  sync?: boolean;
}

export interface CanvaControlResult {
  success: boolean;
  action: string;
  pipelines: import("./pipgm-model.js").PiPgmPipelineSnapshot[];
}
