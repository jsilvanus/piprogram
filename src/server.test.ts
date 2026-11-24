import assert from "node:assert/strict";
import test from "node:test";
import { buildPipgmServer } from "./server.js";

test("lists the three pipelines and reads one", async () => {
  const app = buildPipgmServer();
  try {
    const list = await app.inject({ method: "GET", url: "/api/v1/pipgm/pipelines" });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().items.length, 3);
    const one = await app.inject({ method: "GET", url: "/api/v1/pipgm/pipelines/PiPGM1" });
    assert.equal(one.statusCode, 200);
    const missing = await app.inject({ method: "GET", url: "/api/v1/pipgm/pipelines/PiPGM9" });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, "PIPELINE_NOT_FOUND");
  } finally {
    await app.close();
  }
});

test("control rejects unknown actions and bad indexes with 422", async () => {
  const app = buildPipgmServer();
  try {
    const bad = await app.inject({ method: "POST", url: "/api/v1/pipgm/pipelines/PiPGM1/control", payload: { action: "explode" } });
    assert.equal(bad.statusCode, 422);
    assert.equal(bad.json().error.code, "INVALID_CONTROL_ACTION");
    const index = await app.inject({
      method: "POST",
      url: "/api/v1/pipgm/pipelines/PiPGM1/control",
      payload: { action: "gotoStep", stepIndex: -1 }
    });
    assert.equal(index.statusCode, 422);
    assert.equal(index.json().error.code, "INVALID_STEP_INDEX");
  } finally {
    await app.close();
  }
});

test("a hymn can be created and read back from the library", async () => {
  const app = buildPipgmServer();
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/pipgm/items/hymn",
      payload: { title: "Testihymni", stanzas: [{ stanzaNumber: 1, lines: ["ensimmäinen säe"] }] }
    });
    assert.equal(created.statusCode, 201);
    const id = created.json().id as string;
    const read = await app.inject({ method: "GET", url: `/api/v1/pipgm/items/${id}` });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().title, "Testihymni");
  } finally {
    await app.close();
  }
});

test("a YouTube URL that holds no video ID is refused", async () => {
  const app = buildPipgmServer();
  try {
    const res = await app.inject({ method: "POST", url: "/api/v1/pipgm/items/youtube", payload: { urlOrId: "https://example.com/x" } });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.code, "INVALID_YOUTUBE_URL");
  } finally {
    await app.close();
  }
});

test("the stage page is served as HTML", async () => {
  const app = buildPipgmServer();
  try {
    const res = await app.inject({ method: "GET", url: "/pipgm/PiPGM2/stage" });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /text\/html/);
  } finally {
    await app.close();
  }
});

test("with an API key, writes need the key and reads stay open", async () => {
  const app = buildPipgmServer({ apiKey: "s3cret-key" });
  try {
    const read = await app.inject({ method: "GET", url: "/api/v1/pipgm/pipelines" });
    assert.equal(read.statusCode, 200);
    const anonymous = await app.inject({ method: "POST", url: "/api/v1/pipgm/items/hymn", payload: { title: "x" } });
    assert.equal(anonymous.statusCode, 401);
    const bearer = await app.inject({
      method: "POST",
      url: "/api/v1/pipgm/items/hymn",
      headers: { authorization: "Bearer s3cret-key" },
      payload: { title: "x" }
    });
    assert.equal(bearer.statusCode, 201);
    const header = await app.inject({
      method: "POST",
      url: "/api/v1/pipgm/items/hymn",
      headers: { "x-api-key": "s3cret-key" },
      payload: { title: "y" }
    });
    assert.equal(header.statusCode, 201);
  } finally {
    await app.close();
  }
});

test("playlist/steps lists every step of the playlist in order and marks the active one", async () => {
  const app = buildPipgmServer();
  try {
    const ids: string[] = [];
    for (const title of ["Eka", "Toka"]) {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/pipgm/items/hymn",
        payload: { title, stanzas: [{ stanzaNumber: 1, lines: ["a"] }, { stanzaNumber: 2, lines: ["b"] }] }
      });
      ids.push(created.json().id as string);
      await app.inject({ method: "POST", url: "/api/v1/pipgm/pipelines/PiPGM1/playlist", payload: { itemId: ids.at(-1) } });
    }
    await app.inject({ method: "POST", url: "/api/v1/pipgm/pipelines/PiPGM1/control", payload: { action: "gotoItem", itemId: ids[1] } });
    const res = await app.inject({ method: "GET", url: "/api/v1/pipgm/pipelines/PiPGM1/playlist/steps" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.pipelineId, "PiPGM1");
    assert.equal(body.activeItemId, ids[1]);
    const rows = body.steps as Array<{ itemId: string; itemIndex: number; stepIndex: number; thumbnailUrl: string | null; isActive: boolean }>;
    assert.ok(rows.length >= 2);
    assert.deepEqual([...new Set(rows.map((r) => r.itemId))], ids);
    assert.deepEqual(rows.filter((r) => r.isActive).map((r) => [r.itemId, r.stepIndex]), [[ids[1], 0]]);
    assert.ok(rows.every((r) => r.thumbnailUrl === null));
    const missing = await app.inject({ method: "GET", url: "/api/v1/pipgm/pipelines/PiPGM9/playlist/steps" });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("playlist/order reorders, replaces and refuses unknown ids without changing anything, and allows repeats", async () => {
  const app = buildPipgmServer();
  try {
    const ids: string[] = [];
    for (const title of ["A", "B", "C"]) {
      const created = await app.inject({ method: "POST", url: "/api/v1/pipgm/items/hymn", payload: { title, stanzas: [{ lines: ["x"] }] } });
      ids.push(created.json().id as string);
    }
    const put = (itemIds: unknown) =>
      app.inject({ method: "PUT", url: "/api/v1/pipgm/pipelines/PiPGM1/playlist/order", payload: { itemIds } });
    const titles = async () =>
      ((await app.inject({ method: "GET", url: "/api/v1/pipgm/pipelines/PiPGM1" })).json().playlist as Array<{ title: string }>).map((i) => i.title);

    assert.equal((await put([ids[0], ids[1]])).statusCode, 200);
    assert.deepEqual(await titles(), ["A", "B"]);
    // the first item is active; reordering keeps it active at step 0
    const reordered = await put([ids[1], ids[2], ids[0]]);
    assert.equal(reordered.json().activeItemId, ids[0]);
    assert.deepEqual(await titles(), ["B", "C", "A"]);
    // dropping the active item moves the active one to the first remaining
    const dropped = await put([ids[2], ids[1]]);
    assert.equal(dropped.json().activeItemId, ids[2]);

    const unknown = await put([ids[1], "nope"]);
    assert.equal(unknown.statusCode, 422);
    assert.equal(unknown.json().error.code, "UNKNOWN_ITEMS");
    assert.equal((await put("x")).statusCode, 422);
    assert.deepEqual(await titles(), ["C", "B"]);
    // the same item may be listed twice; each copy is its own entry
    const dup = await put([ids[1], ids[1], ids[2]]);
    assert.equal(dup.statusCode, 200);
    assert.deepEqual(await titles(), ["B", "B", "C"]);
    const entryIds = (dup.json().playlist as Array<{ entryId: string }>).map((i) => i.entryId);
    assert.notEqual(entryIds[0], entryIds[1]);
    // entry ids reorder the existing entries
    const swapped = await put([entryIds[2], entryIds[1], entryIds[0]]);
    assert.deepEqual((swapped.json().playlist as Array<{ entryId: string }>).map((i) => i.entryId), [entryIds[2], entryIds[1], entryIds[0]]);
    // removing by entry id drops just that copy
    const removed = await app.inject({ method: "DELETE", url: `/api/v1/pipgm/pipelines/PiPGM1/playlist/${entryIds[1]}` });
    assert.equal(removed.statusCode, 200);
    assert.deepEqual(await titles(), ["C", "B"]);
    await put([ids[1], ids[2]]);

    assert.equal((await put([])).json().activeItemId, null);
    assert.equal((await app.inject({ method: "PUT", url: "/api/v1/pipgm/pipelines/PiPGM9/playlist/order", payload: { itemIds: [] } })).statusCode, 404);
  } finally {
    await app.close();
  }
});

test("saved playlists: create, list, read, replace, delete and the validation errors", async () => {
  const app = buildPipgmServer();
  try {
    const base = "/api/v1/pipgm/playlists";
    const bad = await app.inject({ method: "POST", url: base, payload: { name: "", items: [{}] } });
    assert.equal(bad.statusCode, 422);
    assert.equal(bad.json().error.code, "INVALID_PLAYLIST");
    assert.ok(bad.json().error.errors.length >= 2);

    const created = await app.inject({ method: "POST", url: base, payload: { name: "Messu", items: [{ itemId: "hymn-1", hymn: { number: 336 } }] } });
    assert.equal(created.statusCode, 201);
    const id = created.json().id as string;
    assert.equal(created.json().schema, "piprogram.playlist/1");
    assert.deepEqual((await app.inject({ method: "GET", url: base })).json().items.map((i: { id: string; itemCount: number }) => [i.id, i.itemCount]), [[id, 1]]);
    assert.equal((await app.inject({ method: "GET", url: `${base}/${id}` })).json().items[0].hymn.number, 336);

    const put = await app.inject({ method: "PUT", url: `${base}/${id}`, payload: { name: "Messu 2", items: [] } });
    assert.equal(put.statusCode, 200);
    assert.equal(put.json().name, "Messu 2");
    assert.equal((await app.inject({ method: "PUT", url: `${base}/pl-000000000000`, payload: { name: "x", items: [] } })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: `${base}/nope` })).json().error.code, "PLAYLIST_NOT_FOUND");

    assert.equal((await app.inject({ method: "DELETE", url: `${base}/${id}` })).statusCode, 204);
    assert.equal((await app.inject({ method: "DELETE", url: `${base}/${id}` })).statusCode, 404);
  } finally {
    await app.close();
  }
});

test("playlist/save stores a feed's playlist with kinds, titles and hymn numbers, new or over an old one", async () => {
  const app = buildPipgmServer();
  try {
    const hymn = (await app.inject({ method: "POST", url: "/api/v1/pipgm/items/hymn", payload: { title: "Virsi 336", hymnNumber: "336", stanzas: [{ lines: ["a"] }] } })).json().id as string;
    await app.inject({ method: "POST", url: "/api/v1/pipgm/pipelines/PiPGM2/playlist", payload: { itemId: hymn } });
    const url = "/api/v1/pipgm/pipelines/PiPGM2/playlist/save";
    const saved = await app.inject({ method: "POST", url, payload: { name: "Sunnuntai" } });
    assert.equal(saved.statusCode, 201);
    assert.deepEqual(saved.json().items, [{ itemId: hymn, kind: "hymn", title: "336 Virsi 336", hymn: { number: 336 } }]);
    assert.equal(saved.json().orientation, "landscape");
    assert.equal((await app.inject({ method: "POST", url, payload: {} })).statusCode, 422);

    await app.inject({ method: "PUT", url: "/api/v1/pipgm/pipelines/PiPGM2/playlist/order", payload: { itemIds: [] } });
    const over = await app.inject({ method: "POST", url, payload: { name: "Sunnuntai", playlistId: saved.json().id } });
    assert.equal(over.statusCode, 200);
    assert.equal(over.json().id, saved.json().id);
    assert.equal(over.json().items.length, 0);
    assert.equal((await app.inject({ method: "POST", url, payload: { name: "x", playlistId: "pl-000000000000" } })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url, payload: { name: "x", playlistId: "junk" } })).statusCode, 422);
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/pipgm/pipelines/PiPGM9/playlist/save", payload: { name: "x" } })).statusCode, 404);
  } finally {
    await app.close();
  }
});

test("saved playlists answer 503 while the store is down", async () => {
  const { MemoryBlobStore } = await import("./library-store.js");
  const blobs = new MemoryBlobStore();
  const app = buildPipgmServer({ playlistStore: blobs });
  try {
    blobs.failing = true;
    const res = await app.inject({ method: "GET", url: "/api/v1/pipgm/playlists" });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, "STORAGE_UNAVAILABLE");
  } finally {
    await app.close();
  }
});

async function hymnItem(app: ReturnType<typeof buildPipgmServer>, title: string, hymnNumber?: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/pipgm/items/hymn",
    payload: { title, ...(hymnNumber ? { hymnNumber } : {}), stanzas: [{ lines: ["a"] }, { lines: ["b"] }, { lines: ["c"] }] }
  });
  return res.json().id as string;
}

test("playlist/load replaces a playlist without touching what is on air", async () => {
  const app = buildPipgmServer();
  try {
    const [a, b, c, d] = [await hymnItem(app, "A"), await hymnItem(app, "B"), await hymnItem(app, "C"), await hymnItem(app, "D")];
    const feed = "/api/v1/pipgm/pipelines/PiPGM1";
    const put = (itemIds: string[]) => app.inject({ method: "PUT", url: `${feed}/playlist/order`, payload: { itemIds } });
    const save = async (name: string) => (await app.inject({ method: "POST", url: `${feed}/playlist/save`, payload: { name } })).json().id as string;
    const load = (body: object) => app.inject({ method: "POST", url: `${feed}/playlist/load`, payload: body });
    const state = async () => (await app.inject({ method: "GET", url: feed })).json();

    await put([a, b]);
    const ab = await save("AB");
    await put([c, d]);
    const cd = await save("CD");

    // nothing on air: the list is replaced and nothing is cued
    await app.inject({ method: "POST", url: `${feed}/control`, payload: { action: "stop" } });
    await app.inject({ method: "DELETE", url: `${feed}/playlist/${c}` });
    await app.inject({ method: "DELETE", url: `${feed}/playlist/${d}` });
    let res = await load({ playlistId: ab });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().pipeline.playlist.map((i: { id: string }) => i.id), [a, b]);
    assert.equal(res.json().report.keptActiveItemId, null);

    // on air at step 1 of B; the new list holds B at another place: B and its step stay
    await app.inject({ method: "POST", url: `${feed}/control`, payload: { action: "gotoItem", itemId: b, stepIndex: 1 } });
    await put([b, a]);
    await put([a, b]);
    res = await load({ playlistId: (await save("AB again")) });
    assert.equal(res.json().report.keptActiveItemId, b);
    assert.equal(res.json().report.carriedActiveItem, false);
    assert.equal(res.json().pipeline.activeItemId, b);
    assert.equal(res.json().pipeline.currentStep, 1);

    // the new list does not hold the item on air: it stays, first in the list, until the feed moves on
    res = await load({ playlistId: cd });
    assert.equal(res.json().report.carriedActiveItem, true);
    assert.equal(res.json().pipeline.activeItemId, b);
    assert.equal(res.json().pipeline.currentStep, 1);
    assert.deepEqual(res.json().pipeline.playlist.map((i: { id: string }) => i.id), [b, c, d]);
    // a restart-style reload of the saved ids does not store the carried item
    await app.inject({ method: "POST", url: `${feed}/control`, payload: { action: "gotoStep", stepIndex: 2 } });
    assert.equal((await state()).playlist.length, 3, "still carried while on B");
    const next = await app.inject({ method: "POST", url: `${feed}/control`, payload: { action: "gotoItem", itemId: c } });
    assert.deepEqual(next.json().playlist.map((i: { id: string }) => i.id), [c, d]);
  } finally {
    await app.close();
  }
});

test("playlist/load reports missing items, matches by kind and title or hymn number, and strict refuses", async () => {
  const app = buildPipgmServer();
  try {
    const feed = "/api/v1/pipgm/pipelines/PiPGM3";
    const old = await hymnItem(app, "Old title", "12");
    const gone = await hymnItem(app, "Gone");
    await app.inject({ method: "PUT", url: `${feed}/playlist/order`, payload: { itemIds: [old, gone] } });
    const saved = (await app.inject({ method: "POST", url: `${feed}/playlist/save`, payload: { name: "S" } })).json().id as string;
    // the items are deleted and the hymn 12 and "Gone" are made again as new items
    await app.inject({ method: "DELETE", url: `/api/v1/pipgm/items/${old}` });
    await app.inject({ method: "DELETE", url: `/api/v1/pipgm/items/${gone}` });
    const newHymn = await hymnItem(app, "Another title", "12");

    const res = await app.inject({ method: "POST", url: `${feed}/playlist/load`, payload: { playlistId: saved } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().report.resolved, [{ index: 0, itemId: newHymn, by: "hymnNumber" }]);
    assert.deepEqual(res.json().report.missing.map((m: { itemId: string; title: string }) => [m.itemId, m.title]), [[gone, "Gone"]]);
    assert.deepEqual(res.json().pipeline.playlist.map((i: { id: string }) => i.id), [newHymn]);

    const goneAgain = await hymnItem(app, "Gone"); // same kind and title, new id
    const byTitle = await app.inject({ method: "POST", url: `${feed}/playlist/load`, payload: { playlistId: saved, strict: true } });
    assert.equal(byTitle.statusCode, 200);
    assert.deepEqual(byTitle.json().report.resolved.map((r: { by: string }) => r.by), ["hymnNumber", "kindTitle"]);
    assert.equal(byTitle.json().report.resolved[1].itemId, goneAgain);

    await app.inject({ method: "DELETE", url: `/api/v1/pipgm/items/${goneAgain}` });
    const before = (await app.inject({ method: "GET", url: feed })).json().playlist.length;
    const strict = await app.inject({ method: "POST", url: `${feed}/playlist/load`, payload: { playlistId: saved, strict: true } });
    assert.equal(strict.statusCode, 409);
    assert.equal(strict.json().error.code, "MISSING_ITEMS");
    assert.equal((await app.inject({ method: "GET", url: feed })).json().playlist.length, before);
  } finally {
    await app.close();
  }
});

test("playlist/load appends repeats too, and refuses bad requests", async () => {
  const app = buildPipgmServer();
  try {
    const feed = "/api/v1/pipgm/pipelines/PiPGM2";
    const [a, b] = [await hymnItem(app, "A"), await hymnItem(app, "B")];
    await app.inject({ method: "PUT", url: `${feed}/playlist/order`, payload: { itemIds: [a, b] } });
    const saved = (await app.inject({ method: "POST", url: `${feed}/playlist/save`, payload: { name: "S" } })).json().id as string;
    await app.inject({ method: "DELETE", url: `${feed}/playlist/${b}` });
    const res = await app.inject({ method: "POST", url: `${feed}/playlist/load`, payload: { playlistId: saved, mode: "append" } });
    assert.deepEqual(res.json().pipeline.playlist.map((i: { id: string }) => i.id), [a, a, b]);

    const load = (payload: object) => app.inject({ method: "POST", url: `${feed}/playlist/load`, payload });
    assert.equal((await load({})).json().error.code, "PLAYLIST_ID_REQUIRED");
    assert.equal((await load({ playlistId: saved, mode: "merge" })).json().error.code, "INVALID_MODE");
    assert.equal((await load({ playlistId: "pl-000000000000" })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/pipgm/pipelines/PiPGM9/playlist/load", payload: { playlistId: saved } })).statusCode, 404);
  } finally {
    await app.close();
  }
});

test("playlists/generate drafts a day from useAt: hymns first, then by time, nothing saved", async () => {
  const app = buildPipgmServer();
  try {
    const make = async (title: string, useAt: string) => {
      const id = await hymnItem(app, title);
      await app.inject({ method: "PUT", url: `/api/v1/pipgm/items/${id}/use-at`, payload: { useAt } });
      return id;
    };
    const late = await make("Late", "2026-11-22T11:30");
    const early = await make("Early", "2026-11-22T09");
    const range = await make("Range", "2026-11-20/2026-11-23");
    await make("Other day", "2026-11-29");
    await hymnItem(app, "No date");
    const img = (await app.inject({ method: "POST", url: "/api/v1/pipgm/items/media", payload: { kind: "image", filename: "a.png", dataBase64: "AA==" } })).json().id as string;
    await app.inject({ method: "PUT", url: `/api/v1/pipgm/items/${img}/use-at`, payload: { useAt: "2026-11-22" } });

    const res = await app.inject({ method: "POST", url: "/api/v1/pipgm/playlists/generate", payload: { date: "2026-11-22", orientation: "portrait" } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().draft.orientation, "portrait");
    assert.equal(res.json().draft.name, "Draft 2026-11-22");
    // hymns by time of day (the range starts at the day's beginning), the image last
    assert.deepEqual(res.json().draft.items.map((i: { itemId: string }) => i.itemId), [range, early, late, img]);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/pipgm/playlists" })).json().items.length, 0);

    assert.equal((await app.inject({ method: "POST", url: "/api/v1/pipgm/playlists/generate", payload: {} })).json().error.code, "DATE_REQUIRED");
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/pipgm/playlists/generate", payload: { date: "22.11.2026" } })).json().error.code, "INVALID_DATE");
  } finally {
    await app.close();
  }
});

test("pauses and auto-advance seconds are kept in a saved playlist; a load skips the pauses and says so", async () => {
  const app = buildPipgmServer();
  try {
    const a = await hymnItem(app, "A");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/pipgm/playlists",
      payload: { name: "Timed", items: [{ itemId: a, advanceSeconds: 45 }, { pause: true, label: "Sermon" }] }
    });
    assert.equal(created.statusCode, 201);
    const id = created.json().id as string;
    assert.deepEqual((await app.inject({ method: "GET", url: `/api/v1/pipgm/playlists/${id}` })).json().items, [
      { itemId: a, advanceSeconds: 45 },
      { pause: true, label: "Sermon" }
    ]);
    const loaded = await app.inject({ method: "POST", url: "/api/v1/pipgm/pipelines/PiPGM1/playlist/load", payload: { playlistId: id } });
    assert.equal(loaded.statusCode, 200);
    assert.deepEqual(loaded.json().report.skipped, [{ index: 1, reason: "pause-not-supported" }]);
    assert.deepEqual(loaded.json().report.missing, []);
    assert.deepEqual(loaded.json().pipeline.playlist.map((i: { id: string }) => i.id), [a]);
    const bad = await app.inject({ method: "POST", url: "/api/v1/pipgm/playlists", payload: { name: "x", items: [{ pause: true, itemId: a }] } });
    assert.equal(bad.statusCode, 422);
  } finally {
    await app.close();
  }
});

test("a hymn gets used-on dates: several, sorted, no duplicates, removable; refused when not a day", async () => {
  const app = buildPipgmServer();
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/pipgm/items/hymn",
      payload: { title: "Käyttöhymni", stanzas: [{ stanzaNumber: 1, lines: ["säe"] }] }
    });
    const id = created.json().id as string;
    const url = `/api/v1/pipgm/items/${id}/used-on`;
    assert.equal((await app.inject({ method: "POST", url, payload: { date: "2026-11-29" } })).statusCode, 200);
    const again = await app.inject({ method: "POST", url, payload: { date: "2026-11-08" } });
    assert.deepEqual(again.json().usedOn, ["2026-11-08", "2026-11-29"]);
    const dup = await app.inject({ method: "POST", url, payload: { date: "2026-11-08" } });
    assert.deepEqual(dup.json().usedOn, ["2026-11-08", "2026-11-29"]);
    assert.equal((await app.inject({ method: "POST", url, payload: { date: "2026-02-30" } })).statusCode, 422);
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/pipgm/items/nope/used-on", payload: { date: "2026-11-08" } })).statusCode, 404);
    const removed = await app.inject({ method: "DELETE", url: `${url}/2026-11-08` });
    assert.deepEqual(removed.json().usedOn, ["2026-11-29"]);
    // Hymns are not in the expiring (Canva) set: nothing in the item says it is to be cleaned up.
    assert.equal((removed.json() as { expiresAt?: string }).expiresAt, undefined);
  } finally {
    await app.close();
  }
});
