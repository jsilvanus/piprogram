/**
 * `usedOn`: the days an item was actually used (a hymn sung on 2026-11-08, sung again on 2026-11-29).
 * Unlike `useAt` (when an item is meant to be used), these are a record of past use. An item can have
 * several. Stored as a sorted list of unique YYYY-MM-DD dates; a missing list means no date yet.
 */

export class UsedOnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsedOnError";
  }
}

export const MAX_USED_ON_DATES = 366;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Checks one YYYY-MM-DD date. Throws UsedOnError for anything else (including 2026-02-30). */
export function parseUsedOnDate(input: unknown): string {
  if (typeof input !== "string") throw new UsedOnError("a used-on date is a string such as 2026-11-08");
  const text = input.trim();
  const m = DAY.exec(text);
  if (!m) throw new UsedOnError(`not a day (use 2026-11-08): ${input}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    throw new UsedOnError(`not a real date: ${text}`);
  }
  return text;
}

/** The list with one date added, sorted and without duplicates. */
export function addUsedOn(list: readonly string[] | undefined, date: string): string[] {
  const next = [...new Set([...(list ?? []), date])].sort();
  if (next.length > MAX_USED_ON_DATES) throw new UsedOnError(`at most ${MAX_USED_ON_DATES} used-on dates`);
  return next;
}

/** The list with one date removed (an empty list means none). */
export function removeUsedOn(list: readonly string[] | undefined, date: string): string[] {
  return (list ?? []).filter((d) => d !== date);
}
