/**
 * Hymnals. One library holds hymns from several books; the book is told by a prefix on the hymn number:
 * "123" or "VK 123" is the Virsikirja, "LV 12" is Lasten virsi, and so on. The list of known books is configurable
 * (PIPGM_HYMNALS), but any prefix of 1-6 letters works: an unknown one is shown as its own book, named by the prefix.
 */

export interface Hymnal {
  /** Upper-case letters, 1-6 (VK, LV). */
  prefix: string;
  name: string;
}

/** The prefix of a number written without one. */
export const DEFAULT_HYMNAL_PREFIX = "VK";

export const DEFAULT_HYMNALS: readonly Hymnal[] = [
  { prefix: "VK", name: "Virsikirja (Suomen evankelis-luterilaisen kirkon virsikirja)" },
  { prefix: "LV", name: "Lasten virsi" }
];

export const HYMNAL_PREFIX = /^[A-Z]{1,6}$/;

/**
 * Reads the list from `VK=Virsikirja,LV=Lasten virsi` or a JSON array of {prefix, name}. Invalid entries are
 * dropped; an empty or unreadable setting gives the defaults. The default prefix (VK) is always in the list.
 */
export function parseHymnals(setting: string | undefined): Hymnal[] {
  const text = setting?.trim();
  const found: Hymnal[] = [];
  if (text) {
    let raw: Array<{ prefix?: unknown; name?: unknown }> = [];
    if (text.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) raw = parsed as typeof raw;
      } catch {
        raw = [];
      }
    } else {
      raw = text.split(",").map((part) => {
        const at = part.indexOf("=");
        return at < 0 ? { prefix: part, name: part } : { prefix: part.slice(0, at), name: part.slice(at + 1) };
      });
    }
    for (const entry of raw) {
      const prefix = typeof entry.prefix === "string" ? entry.prefix.trim().toUpperCase() : "";
      const name = typeof entry.name === "string" ? entry.name.trim() : "";
      if (HYMNAL_PREFIX.test(prefix) && !found.some((h) => h.prefix === prefix)) found.push({ prefix, name: name || prefix });
    }
  }
  if (!found.length) return DEFAULT_HYMNALS.map((h) => ({ ...h }));
  if (!found.some((h) => h.prefix === DEFAULT_HYMNAL_PREFIX)) found.unshift({ ...DEFAULT_HYMNALS[0]! });
  return found;
}

export interface HymnNumber {
  /** Upper case; the default prefix when the number was written without one. */
  prefix: string;
  /** The number part as written (digits, possibly with a letter: 12b). */
  number: string;
  /** True when the text had a prefix of its own. */
  explicit: boolean;
}

/** "LV12", "lv 12", "VK-5", "123" -> prefix and number. Null when it does not look like a hymn number. */
export function splitHymnNumber(raw: string | undefined | null): HymnNumber | null {
  const m = /^\s*(?:([A-Za-zÅÄÖåäö]{1,6})[\s.\-:]*)?(\d+[a-zA-Z]?)\s*$/.exec(raw ?? "");
  if (!m) return null;
  const prefix = m[1] ? m[1].toUpperCase() : undefined;
  if (prefix !== undefined && !HYMNAL_PREFIX.test(prefix)) return null;
  return { prefix: prefix ?? DEFAULT_HYMNAL_PREFIX, number: m[2]!, explicit: prefix !== undefined };
}

/** The number as stored: "LV 12" with a prefix, the plain number without. Text that is no hymn number stays as typed. */
export function formatHymnNumber(raw: string | undefined | null): string {
  const text = (raw ?? "").trim();
  const split = splitHymnNumber(text);
  if (!split) return text;
  return split.explicit ? `${split.prefix} ${split.number}` : split.number;
}

/** Two numbers name the same hymn: "123", "VK 123" and "vk123" do; "LV 123" does not. */
export function sameHymnNumber(a: string | undefined | null, b: string | undefined | null): boolean {
  const x = splitHymnNumber(a);
  const y = splitHymnNumber(b);
  if (x && y) return x.prefix === y.prefix && x.number.toLowerCase() === y.number.toLowerCase();
  return (a ?? "").trim() === (b ?? "").trim();
}

/** The hymnal prefix of a hymn number (VK when there is none or it is not a number). */
export function hymnalPrefixOf(hymnNumber: string | undefined | null): string {
  return splitHymnNumber(hymnNumber)?.prefix ?? DEFAULT_HYMNAL_PREFIX;
}
