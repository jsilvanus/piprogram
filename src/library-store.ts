/**
 * Durable storage for the media library (uploaded images, audio, video and .pptx files, and the
 * library items made from them). The bytes and a small JSON per item live in pistorage, which keeps
 * them in S3 (VersityGW, Hetzner) and caches recent files on the Pi. Prepared speech is not stored
 * here: it is derived from text and is rebuilt on demand, so it stays in the local cache directory.
 *
 * Keys: <prefix>/items/<itemId>.json and <prefix>/assets/<assetId>. A write that fails (pistorage or
 * the backend is down) is kept as pending by the service and retried; it is never dropped silently.
 */

import type { PiPgmAsset, PiPgmItem } from "./pipgm-model.js";

export interface BlobPutOptions {
  contentType?: string | undefined;
  /** ISO 8601 deadline after which the object may be deleted (pistorage retention). */
  expiresAt?: string | undefined;
  /** When the object is meant to be used (src/use-at.ts); pistorage then has it in the Pi cache beforehand. */
  useAt?: string[] | undefined;
}

export interface BlobStore {
  put(key: string, data: Buffer, options?: BlobPutOptions): Promise<void>;
  /** The bytes, or null when the object does not exist. Throws when the store cannot be reached. */
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  /** All keys under a prefix. */
  list(prefix: string): Promise<string[]>;
}

export class MemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, Buffer>();
  /** The options of the last write of each key (for tests). */
  readonly writeOptions = new Map<string, BlobPutOptions | undefined>();
  failing = false;

  private check(): void {
    if (this.failing) throw new Error("store unavailable");
  }
  async put(key: string, data: Buffer, options?: BlobPutOptions): Promise<void> {
    this.check();
    this.writeOptions.set(key, options);
    this.objects.set(key, Buffer.from(data));
  }
  async get(key: string): Promise<Buffer | null> {
    this.check();
    const found = this.objects.get(key);
    return found ? Buffer.from(found) : null;
  }
  async delete(key: string): Promise<void> {
    this.check();
    this.objects.delete(key);
  }
  async list(prefix: string): Promise<string[]> {
    this.check();
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix));
  }
}

export interface PiStorageBlobStoreOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

/** pistorage over HTTP. Reads and writes send the API key as a Bearer token when one is set. */
export class PiStorageBlobStore implements BlobStore {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: PiStorageBlobStoreOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private url(key: string): string {
    return `${this.baseUrl}/api/v1/objects/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}), ...extra };
  }

  async put(key: string, data: Buffer, options: BlobPutOptions = {}): Promise<void> {
    const response = await this.fetchImpl(this.url(key), {
      method: "PUT",
      headers: this.headers({
        "content-type": options.contentType ?? "application/octet-stream",
        "content-length": String(data.length),
        ...(options.expiresAt ? { "x-pistorage-expires-at": options.expiresAt } : {}),
        ...(options.useAt?.length ? { "x-pistorage-use-at": options.useAt.join(", ") } : {})
      }),
      body: new Uint8Array(data),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) throw new Error(`pistorage answered ${response.status} to a write of ${key}`);
  }

  async get(key: string): Promise<Buffer | null> {
    const response = await this.fetchImpl(this.url(key), {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`pistorage answered ${response.status} to a read of ${key}`);
    return Buffer.from(await response.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const response = await this.fetchImpl(this.url(key), {
      method: "DELETE",
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok && response.status !== 404) throw new Error(`pistorage answered ${response.status} to a delete of ${key}`);
  }

  async list(prefix: string): Promise<string[]> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/objects?${new URLSearchParams({ prefix, limit: "1000" })}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) throw new Error(`pistorage answered ${response.status} to a listing of ${prefix}`);
    const body = (await response.json()) as { items?: Array<{ key: string }> };
    return (body.items ?? []).map((o) => o.key);
  }
}

/** What is stored per item: the item, and the metadata of the asset its bytes belong to. */
export type StoredAsset = Omit<PiPgmAsset, "data" | "filePath">;

export interface StoredLibraryEntry {
  version: 1;
  item: PiPgmItem;
  /** Every asset the item uses (a Canva package has one per page). */
  assets?: StoredAsset[];
  /** Entries written before an item could have several assets. */
  asset?: StoredAsset | null;
}

/** The assets of a stored entry, old or new format. */
export function assetsOfEntry(entry: StoredLibraryEntry): StoredAsset[] {
  return entry.assets ?? (entry.asset ? [entry.asset] : []);
}

export class LibraryPersistence {
  constructor(
    private readonly store: BlobStore,
    private readonly prefix = "piprogram/library"
  ) {}

  private itemKey(itemId: string): string {
    return `${this.prefix}/items/${itemId}.json`;
  }
  private assetKey(assetId: string): string {
    return `${this.prefix}/assets/${assetId}`;
  }

  /** Bytes first, then the item JSON: a listed item always has its bytes. */
  async save(item: PiPgmItem, assets: PiPgmAsset[], expiresAt?: string): Promise<void> {
    const useAt = item.useAt?.length ? item.useAt : undefined;
    for (const asset of assets) {
      if (asset.data) await this.store.put(this.assetKey(asset.id), asset.data, { contentType: asset.mimeType, expiresAt, useAt });
    }
    const metas = assets.map(({ data: _data, filePath: _filePath, ...meta }) => meta);
    const entry: StoredLibraryEntry = { version: 1, item, assets: metas };
    await this.store.put(this.itemKey(item.id), Buffer.from(JSON.stringify(entry)), {
      contentType: "application/json",
      expiresAt,
      useAt
    });
  }

  async remove(itemId: string, assetIds: string[]): Promise<void> {
    await this.store.delete(this.itemKey(itemId));
    for (const assetId of assetIds) await this.store.delete(this.assetKey(assetId));
  }

  async removeAssets(assetIds: string[]): Promise<void> {
    for (const id of assetIds) await this.store.delete(this.assetKey(id));
  }

  async readAsset(assetId: string): Promise<Buffer | null> {
    return this.store.get(this.assetKey(assetId));
  }

  /** Every stored entry. An unreadable one is skipped and reported through onSkip. */
  async loadAll(onSkip?: (key: string, reason: string) => void): Promise<StoredLibraryEntry[]> {
    const keys = (await this.store.list(`${this.prefix}/items/`)).filter((k) => k.endsWith(".json"));
    const entries: StoredLibraryEntry[] = [];
    for (const key of keys.sort()) {
      try {
        const bytes = await this.store.get(key);
        if (!bytes) continue;
        const entry = JSON.parse(bytes.toString("utf8")) as StoredLibraryEntry;
        if (entry.version !== 1 || typeof entry.item?.id !== "string") throw new Error("not a library entry");
        entries.push(entry);
      } catch (error) {
        onSkip?.(key, error instanceof Error ? error.message : String(error));
      }
    }
    return entries;
  }
}
