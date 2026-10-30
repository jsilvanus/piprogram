/**
 * Client for interacting with `piswitch` video mixer and media pool APIs.
 * Connects piprogram to piswitch's 6-slot circular slide buffer and media player still pool.
 */

export interface SlideBufferState {
  currentSlot: number;
  previousSlot: number | null;
  lookaheadSlots: number[];
  cleanedSlot: number | null;
  totalSlots: number;
}

export interface SlideAdvanceResult {
  activeSlot: number;
  cleanedSlot: number | null;
  lookaheadSlots: number[];
  mediaPlayer: number;
}

export interface SlideUploadResult {
  slot: number;
  name?: string;
  pool: "slides" | "graphics";
  bytes: number;
}

export interface MediaPlayerState {
  player: number;
  stillSlot: number;
  clipIndex: number;
  isPlaying: boolean;
  loop: boolean;
}

export interface PiSwitchClientOptions {
  baseUrl?: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export class PiSwitchError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly code?: string
  ) {
    super(message);
    this.name = "PiSwitchError";
  }
}

export class PiSwitchClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: PiSwitchClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.PISWITCH_URL ?? "http://127.0.0.1:3200").replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? process.env.PISWITCH_API_KEY?.trim() ?? undefined;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  get configuredUrl(): string {
    return this.baseUrl;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.apiKey) {
      h["Authorization"] = `Bearer ${this.apiKey}`;
      h["x-api-key"] = this.apiKey;
    }
    return h;
  }

  private async request<T>(
    endpoint: string,
    options: {
      method?: string;
      body?: BodyInit;
      headers?: Record<string, string>;
    } = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(url, {
        method: options.method ?? "GET",
        headers: this.headers(options.headers),
        body: options.body,
        signal: controller.signal
      });

      if (!response.ok) {
        let errCode = "UNKNOWN_ERROR";
        let errMsg = `piswitch request failed with HTTP ${response.status}`;
        try {
          const errBody = (await response.json()) as { error?: { code?: string; message?: string } };
          if (errBody?.error?.code) errCode = errBody.error.code;
          if (errBody?.error?.message) errMsg = errBody.error.message;
        } catch {
          // ignore json parse error
        }
        throw new PiSwitchError(errMsg, response.status, errCode);
      }

      return (await response.json()) as T;
    } catch (err: unknown) {
      if (err instanceof PiSwitchError) throw err;
      const isAbort = (err as Error)?.name === "AbortError";
      throw new PiSwitchError(
        isAbort ? `piswitch request timed out after ${this.timeoutMs}ms` : (err as Error).message,
        undefined,
        isAbort ? "TIMEOUT" : "NETWORK_ERROR"
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Checks if piswitch is reachable. */
  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await this.fetchFn(`${this.baseUrl}/health`, {
        signal: controller.signal
      });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Gets current slide buffer state (active slot, lookahead slots, cleaned slot). */
  async getSlideStatus(): Promise<SlideBufferState> {
    return this.request<SlideBufferState>("/api/v1/video-mixer/media-pool/slides/status");
  }

  /**
   * Advances the circular slide buffer to the next slot (or a specific target slot).
   * Directs Media Player 1 to the newly active slot and frees slot (N - 2).
   */
  async advanceSlide(targetSlot?: number): Promise<SlideAdvanceResult> {
    return this.request<SlideAdvanceResult>("/api/v1/video-mixer/media-pool/slides/advance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(targetSlot !== undefined ? { slot: targetSlot } : {})
    });
  }

  /**
   * Uploads an image still (e.g. rendered slide frame) to a media pool slot.
   */
  async uploadStill(
    slot: number,
    imageData: Buffer | Uint8Array,
    name?: string,
    pool: "slides" | "graphics" = "slides"
  ): Promise<SlideUploadResult> {
    const qName = name ? `&name=${encodeURIComponent(name)}` : "";
    const endpoint = `/api/v1/video-mixer/media-pool/slots/${slot}?pool=${pool}${qName}`;
    return this.request<SlideUploadResult>(endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: imageData as unknown as BodyInit
    });
  }

  /** Selects still slot source for a media player (1..4). */
  async setMediaPlayerSource(player: number, slot: number): Promise<{ player: number; stillSlot: number }> {
    return this.request<{ player: number; stillSlot: number }>(`/api/v1/video-mixer/media-players/${player}/source`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot })
    });
  }

  /** Retrieves all media players and their active still assignments. */
  async getMediaPlayers(): Promise<{ players: MediaPlayerState[] }> {
    return this.request<{ players: MediaPlayerState[] }>("/api/v1/video-mixer/media-players");
  }
}
