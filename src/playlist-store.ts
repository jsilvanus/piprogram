/**
 * Saved playlists: named lists of library items that can be loaded onto a feed later. A saved playlist
 * refers to library items by id (with kind and title as a fallback match, and the hymn number so that
 * a hymn can be rebuilt); it holds no slides or bytes. Each is one JSON document, kept in the same
 * blob store as the library at <prefix>/<id>.json (pistorage in production, memory without it).
 */

import { randomUUID } from "node:crypto";
import { MemoryBlobStore, type BlobStore } from "./library-store.js";
import type { PiPgmItem, PiPgmOrientation } from "./pipgm-model.js";

export const PLAYLIST_SCHEMA = "piprogram.playlist/1";
export const MAX_PLAYLIST_ITEMS = 500;
export const MAX_PLAYLIST_NAME = 120;

export interface SavedPlaylistItem {
  itemId: string;
  kind?: string;
  title?: string;
  hymn?: { number: number | string };
}

/** The document as stored and exchanged (the id is the file name and is not part of the document). */
export interface PlaylistDocument {
  schema: typeof PLAYLIST_SCHEMA;
  name: string;
  savedAt: string;
  orientation?: PiPgmOrientation;
  items: SavedPlaylistItem[];
}

export type SavedPlaylist = PlaylistDocument & { id: string };

export interface PlaylistSummary {
  id: string;
  name: string;
  savedAt: string;
  orientation?: PiPgmOrientation;
  itemCount: number;
}

export type PlaylistValidation = { ok: true; value: Omit<PlaylistDocument, "savedAt"> } | { ok: false; errors: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Checks a playlist document (the `savedAt` and `id` are set by the store and ignored here). Unknown fields are
 * dropped, every problem is reported at once.
 */
export function validatePlaylist(input: unknown): PlaylistValidation {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["body must be an object"] };
  if (input.schema !== undefined && input.schema !== PLAYLIST_SCHEMA) errors.push(`schema must be ${PLAYLIST_SCHEMA}`);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) errors.push("name is required");
  else if (name.length > MAX_PLAYLIST_NAME) errors.push(`name is at most ${MAX_PLAYLIST_NAME} characters`);
  let orientation: PiPgmOrientation | undefined;
  if (input.orientation !== undefined) {
    if (input.orientation === "landscape" || input.orientation === "portrait") orientation = input.orientation;
    else errors.push("orientation must be landscape or portrait");
  }
  const items: SavedPlaylistItem[] = [];
  if (!Array.isArray(input.items)) errors.push("items must be an array");
  else if (input.items.length > MAX_PLAYLIST_ITEMS) errors.push(`items has at most ${MAX_PLAYLIST_ITEMS} entries`);
  else {
    input.items.forEach((raw, i) => {
      if (!isRecord(raw)) return void errors.push(`items[${i}] must be an object`);
      const itemId = typeof raw.itemId === "string" ? raw.itemId.trim() : "";
      if (!itemId) return void errors.push(`items[${i}].itemId is required`);
      const item: SavedPlaylistItem = { itemId };
      if (raw.kind !== undefined) {
        if (typeof raw.kind === "string" && raw.kind.length <= 40) item.kind = raw.kind;
        else errors.push(`items[${i}].kind must be a short string`);
      }
      if (raw.title !== undefined) {
        if (typeof raw.title === "string" && raw.title.length <= 200) item.title = raw.title;
        else errors.push(`items[${i}].title must be a string of at most 200 characters`);
      }
      if (raw.hymn !== undefined) {
        const n = isRecord(raw.hymn) ? raw.hymn.number : undefined;
        if ((typeof n === "number" && Number.isInteger(n) && n > 0) || (typeof n === "string" && n.trim() !== "" && n.length <= 20)) {
          item.hymn = { number: n };
        } else errors.push(`items[${i}].hymn.number must be a positive whole number or a short string`);
      }
      items.push(item);
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { schema: PLAYLIST_SCHEMA, name, ...(orientation ? { orientation } : {}), items } };
}

/** How a library item is written into a saved playlist. */
export function savedItemOf(item: PiPgmItem): SavedPlaylistItem {
  const out: SavedPlaylistItem = { itemId: item.id, kind: item.kind, title: item.title };
  if (item.kind === "hymn" && item.hymn?.hymnNumber) {
    const n = item.hymn.hymnNumber.trim();
    out.hymn = { number: /^\d+$/.test(n) ? Number(n) : n };
  }
  return out;
}

const ID_PATTERN = /^pl-[0-9a-f]{12}$/;
export const isPlaylistId = (id: string): boolean => ID_PATTERN.test(id);

export class PlaylistStore {
  constructor(
    private readonly store: BlobStore = new MemoryBlobStore(),
    private readonly prefix = "piprogram/playlists",
    private readonly now: () => number = Date.now
  ) {}

  private key(id: string): string {
    return `${this.prefix}/${id}.json`;
  }

  /** Writes a playlist. A new one gets a fresh id; with `id` an existing one is replaced (null when there is none). */
  async save(doc: Omit<PlaylistDocument, "savedAt">, id?: string): Promise<SavedPlaylist | null> {
    if (id !== undefined && !(await this.get(id))) return null;
    const saved: SavedPlaylist = { ...doc, id: id ?? `pl-${randomUUID().replaceAll("-", "").slice(0, 12)}`, savedAt: new Date(this.now()).toISOString() };
    const { id: _id, ...stored } = saved;
    await this.store.put(this.key(saved.id), Buffer.from(JSON.stringify(stored)), { contentType: "application/json" });
    return saved;
  }

  /** null when there is no such playlist (or it is not readable). Throws when the store is down. */
  async get(id: string): Promise<SavedPlaylist | null> {
    if (!isPlaylistId(id)) return null;
    const bytes = await this.store.get(this.key(id));
    if (!bytes) return null;
    try {
      const raw = JSON.parse(bytes.toString("utf8")) as unknown;
      const checked = validatePlaylist(raw);
      if (!checked.ok || !isRecord(raw) || typeof raw.savedAt !== "string") return null;
      return { ...checked.value, savedAt: raw.savedAt, id };
    } catch {
      return null;
    }
  }

  /** Summaries, newest first. An unreadable document is left out. */
  async list(): Promise<PlaylistSummary[]> {
    const keys = (await this.store.list(`${this.prefix}/`)).filter((k) => k.endsWith(".json"));
    const out: PlaylistSummary[] = [];
    for (const key of keys) {
      const id = key.slice(this.prefix.length + 1, -".json".length);
      const playlist = await this.get(id);
      if (!playlist) continue;
      out.push({
        id,
        name: playlist.name,
        savedAt: playlist.savedAt,
        ...(playlist.orientation ? { orientation: playlist.orientation } : {}),
        itemCount: playlist.items.length
      });
    }
    return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.id.localeCompare(b.id));
  }

  /** False when there was no such playlist. */
  async delete(id: string): Promise<boolean> {
    if (!(await this.get(id))) return false;
    await this.store.delete(this.key(id));
    return true;
  }
}
