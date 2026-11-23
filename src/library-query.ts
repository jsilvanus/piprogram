/**
 * The library as the user browses it: a generic list of items with a type (sound, tts, hymn, song, image, ...),
 * filtered by type, text and the dates the items are meant to be used (`useAt`). Pure functions over items, so the
 * service, the routes and the tests share one rule. The technical `kind` of an item (audio, hymn, image, ...) says
 * how it plays; the `type` says what it is to the people using it. Hymn and song are both stanza items (kind hymn);
 * a recording of a hymn is an audio item whose type the user can set to hymn.
 */

import type { PiPgmItem, PiPgmItemKind } from "./pipgm-model.js";
import { hymnalPrefixOf } from "./hymnals.js";
import { DEFAULT_TIMEZONE, UseAtError, useAtIntervals } from "./use-at.js";

/** Types the UI offers first. Any other name that passes isLibraryType is allowed (an item can be tagged "prayer"). */
export const STANDARD_LIBRARY_TYPES = ["sound", "tts", "hymn", "song", "image", "video", "slides", "canva"] as const;

export const LIBRARY_TYPE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isLibraryType(value: unknown): value is string {
  return typeof value === "string" && LIBRARY_TYPE.test(value);
}

/** A user-typed type as a stored one: trimmed and lower-cased. Undefined when it is not a valid type name. */
export function normalizeLibraryType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const type = value.trim().toLowerCase();
  return isLibraryType(type) ? type : undefined;
}

const DEFAULT_TYPE_OF_KIND: Record<PiPgmItemKind, string> = {
  audio: "sound",
  hymn: "hymn",
  image: "image",
  video: "video",
  youtube: "video",
  pptx: "slides",
  canva: "canva"
};

export function libraryTypeOf(item: PiPgmItem): string {
  if (item.type) return item.type;
  if (item.kind === "audio" && (item.audio?.origin === "tts" || item.id.startsWith("tts-"))) return "tts";
  return DEFAULT_TYPE_OF_KIND[item.kind] ?? "other";
}

export interface LibraryQuery {
  /** One or more types; an item matches any of them. */
  types?: string[];
  kinds?: PiPgmItemKind[];
  /** Hymnal prefixes (VK, LV, ...): only hymn items of those books. A hymn number without a prefix is VK. */
  hymnals?: string[];
  /** Words that must all appear in the title (case-insensitive). */
  text?: string;
  /** Items meant to be used at some time inside [usedFrom, usedTo] (YYYY-MM-DD, either end may be left out). */
  usedFrom?: string;
  usedTo?: string;
  /** true: only items with no useAt; false: only items with one. */
  unscheduled?: boolean;
  sort?: "newest" | "oldest" | "title" | "used";
  limit?: number;
  offset?: number;
  zone?: string;
}

export interface LibraryPage {
  items: PiPgmItem[];
  /** How many items match, before limit and offset. */
  total: number;
  /** The matches per type (counted before the type filter, after every other filter), so a UI can show the chips. */
  types: Array<{ type: string; count: number }>;
  /** The hymn items per hymnal prefix (counted before the hymnal filter, after every other filter), for filter chips. */
  hymnals: Array<{ prefix: string; count: number }>;
}

/** The hymnal prefix of an item, or undefined when it is not a hymn item. */
export function hymnalOf(item: PiPgmItem): string | undefined {
  return item.kind === "hymn" ? hymnalPrefixOf(item.hymn?.hymnNumber) : undefined;
}

export const MAX_LIBRARY_PAGE = 500;

function dayRange(from: string | undefined, to: string | undefined, zone: string): { from: number; to: number } {
  const start = from ? useAtIntervals([from], zone)[0]!.from : Number.NEGATIVE_INFINITY;
  const end = to ? useAtIntervals([to], zone)[0]!.to : Number.POSITIVE_INFINITY;
  if (end < start) throw new UseAtError("usedTo is before usedFrom");
  return { from: start, to: end };
}

/** True when any of the item's use dates overlaps the range. */
export function usedWithin(item: PiPgmItem, range: { from: number; to: number }, zone: string = DEFAULT_TIMEZONE): boolean {
  if (!item.useAt?.length) return false;
  return useAtIntervals(item.useAt, zone).some((i) => i.from <= range.to && i.to >= range.from);
}

function earliestUse(item: PiPgmItem, zone: string): number {
  return item.useAt?.length ? Math.min(...useAtIntervals(item.useAt, zone).map((i) => i.from)) : Number.POSITIVE_INFINITY;
}

/** Filters and sorts library items. Throws UseAtError for a date that is not YYYY-MM-DD. */
export function queryLibrary(all: PiPgmItem[], query: LibraryQuery = {}): LibraryPage {
  const zone = query.zone ?? DEFAULT_TIMEZONE;
  for (const date of [query.usedFrom, query.usedTo]) {
    if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new UseAtError(`dates must be YYYY-MM-DD: ${date}`);
  }
  const range = query.usedFrom || query.usedTo ? dayRange(query.usedFrom, query.usedTo, zone) : undefined;
  const words = (query.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const wanted = query.types?.length ? new Set(query.types) : undefined;

  const beforeType = all.filter((item) => {
    if (query.kinds?.length && !query.kinds.includes(item.kind)) return false;
    if (words.length && !words.every((w) => item.title.toLowerCase().includes(w))) return false;
    if (query.unscheduled === true && item.useAt?.length) return false;
    if (query.unscheduled === false && !item.useAt?.length) return false;
    if (range && !usedWithin(item, range, zone)) return false;
    return true;
  });

  const counts = new Map<string, number>();
  for (const item of beforeType) counts.set(libraryTypeOf(item), (counts.get(libraryTypeOf(item)) ?? 0) + 1);
  const types = [...counts.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  const hymnalCounts = new Map<string, number>();
  for (const item of beforeType) {
    const prefix = hymnalOf(item);
    if (prefix) hymnalCounts.set(prefix, (hymnalCounts.get(prefix) ?? 0) + 1);
  }
  const hymnals = [...hymnalCounts.entries()].map(([prefix, count]) => ({ prefix, count })).sort((a, b) => a.prefix.localeCompare(b.prefix));
  const wantedHymnals = query.hymnals?.length ? new Set(query.hymnals.map((h) => h.toUpperCase())) : undefined;

  const byType = wanted ? beforeType.filter((item) => wanted.has(libraryTypeOf(item))) : beforeType;
  const matches = wantedHymnals ? byType.filter((item) => wantedHymnals.has(hymnalOf(item) ?? "")) : byType;
  const byNewest = (a: PiPgmItem, b: PiPgmItem): number => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
  const sort = query.sort ?? "newest";
  matches.sort(
    sort === "oldest"
      ? (a, b) => -byNewest(a, b)
      : sort === "title"
        ? (a, b) => a.title.localeCompare(b.title, "fi") || byNewest(a, b)
        : sort === "used"
          ? (a, b) => earliestUse(b, zone) - earliestUse(a, zone) || byNewest(a, b)
          : byNewest
  );

  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const limit = query.limit === undefined ? matches.length : Math.min(MAX_LIBRARY_PAGE, Math.max(1, Math.floor(query.limit)));
  return { items: matches.slice(offset, offset + limit), total: matches.length, types, hymnals };
}
