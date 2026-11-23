/**
 * The active folder: the part of the library shown first. It is the items the user added by hand (kept until
 * removed) together with the items whose `useAt` dates cover the chosen day (computed, never stored). Only the
 * hand-picked ids are stored, as one JSON document in the same blob store as the library.
 */
import { MemoryBlobStore, type BlobStore } from "./library-store.js";

export const ACTIVE_SCHEMA = "piprogram.active-folder/1";
export const MAX_ACTIVE_MANUAL = 500;

export interface ActiveEntry {
  itemId: string;
  addedAt: string;
}

interface ActiveDocument {
  schema: typeof ACTIVE_SCHEMA;
  entries: ActiveEntry[];
}

export class ActiveFolderStore {
  constructor(
    private readonly store: BlobStore = new MemoryBlobStore(),
    private readonly key = "piprogram/active-folder.json",
    private readonly now: () => number = Date.now
  ) {}

  /** The hand-picked entries, oldest first. Throws when the store is down; a missing or unreadable document is empty. */
  async list(): Promise<ActiveEntry[]> {
    const bytes = await this.store.get(this.key);
    if (!bytes) return [];
    try {
      const doc = JSON.parse(bytes.toString("utf8")) as Partial<ActiveDocument>;
      if (doc.schema !== ACTIVE_SCHEMA || !Array.isArray(doc.entries)) return [];
      return doc.entries.filter((e): e is ActiveEntry => typeof e?.itemId === "string" && typeof e.addedAt === "string");
    } catch {
      return [];
    }
  }

  private async write(entries: ActiveEntry[]): Promise<void> {
    const doc: ActiveDocument = { schema: ACTIVE_SCHEMA, entries };
    await this.store.put(this.key, Buffer.from(JSON.stringify(doc)), { contentType: "application/json" });
  }

  /** Adds an item (no change when already there). False when the folder is full. */
  async add(itemId: string): Promise<boolean> {
    const entries = await this.list();
    if (entries.some((e) => e.itemId === itemId)) return true;
    if (entries.length >= MAX_ACTIVE_MANUAL) return false;
    entries.push({ itemId, addedAt: new Date(this.now()).toISOString() });
    await this.write(entries);
    return true;
  }

  async remove(itemId: string): Promise<boolean> {
    const entries = await this.list();
    const kept = entries.filter((e) => e.itemId !== itemId);
    if (kept.length === entries.length) return false;
    await this.write(kept);
    return true;
  }

  /** Empties the hand-picked list; returns how many were removed. */
  async clear(): Promise<number> {
    const entries = await this.list();
    if (entries.length > 0) await this.write([]);
    return entries.length;
  }
}
