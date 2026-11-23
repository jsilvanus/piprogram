import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ffmpegAudioNormaliser } from "./audio-upload.js";
import { libraryTypeOf, queryLibrary } from "./library-query.js";
import type { PiPgmItem } from "./pipgm-model.js";
import { buildPipgmServer } from "./server.js";

const item = (over: Partial<PiPgmItem> & { id: string }): PiPgmItem => ({ title: over.id, kind: "image", createdAt: "2026-11-01T00:00:00Z", steps: [], ...over });

test("library types default by kind, tts and explicit type", () => {
  assert.equal(libraryTypeOf(item({ id: "a", kind: "hymn" })), "hymn");
  assert.equal(libraryTypeOf(item({ id: "tts-1", kind: "audio" })), "tts");
  assert.equal(libraryTypeOf(item({ id: "b", kind: "audio" })), "sound");
  assert.equal(libraryTypeOf(item({ id: "c", kind: "hymn", type: "song" })), "song");
});

test("queryLibrary filters by type, text and use dates and counts types", () => {
  const all = [
    item({ id: "1", kind: "audio", title: "Kellot", useAt: ["2026-11-29"] }),
    item({ id: "tts-2", kind: "audio", title: "Tervetuloa" }),
    item({ id: "3", kind: "hymn", title: "Hosianna", type: "song", useAt: ["2026-12-06"], createdAt: "2026-11-02T00:00:00Z" }),
    item({ id: "4", kind: "image", title: "Adventti", useAt: ["2026-11-29/2026-12-24"] })
  ];
  assert.deepEqual(queryLibrary(all, { types: ["sound", "tts"] }).items.map((i) => i.id).sort(), ["1", "tts-2"]);
  const day = queryLibrary(all, { usedFrom: "2026-11-29", usedTo: "2026-11-29" });
  assert.deepEqual(day.items.map((i) => i.id).sort(), ["1", "4"]);
  assert.deepEqual(queryLibrary(all, { unscheduled: true }).items.map((i) => i.id), ["tts-2"]);
  assert.deepEqual(queryLibrary(all, { text: "hosi" }).items.map((i) => i.id), ["3"]);
  const typed = queryLibrary(all, { types: ["song"] });
  assert.equal(typed.total, 1);
  assert.equal(typed.types.length, 4); // chip counts ignore the type filter
  assert.equal(queryLibrary(all, { limit: 2, offset: 1, sort: "title" }).items.length, 2);
  assert.throws(() => queryLibrary(all, { usedFrom: "soon" }));
});

test("items route filters and PATCH sets title and type", async () => {
  const app = buildPipgmServer();
  try {
    const wav = Buffer.alloc(44 + 480, 0);
    wav.write("RIFF", 0); wav.writeUInt32LE(36 + 480, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(480, 40);
    const up = await app.inject({ method: "POST", url: "/api/v1/pipgm/items/media", payload: { kind: "audio", filename: "k.wav", mimeType: "audio/wav", dataBase64: wav.toString("base64"), type: "Jingle", useAt: "2026-11-29", recorded: true } });
    assert.equal(up.statusCode, 201);
    assert.equal(up.json().type, "jingle");
    assert.equal(up.json().audio.origin, "recording");
    assert.deepEqual(up.json().useAt, ["2026-11-29"]);
    const bad = await app.inject({ method: "POST", url: "/api/v1/pipgm/items/media", payload: { kind: "audio", filename: "k.wav", mimeType: "audio/wav", dataBase64: wav.toString("base64"), type: "Not Ok" } });
    assert.equal(bad.statusCode, 422);
    await app.inject({ method: "POST", url: "/api/v1/pipgm/items/hymn", payload: { title: "Laulu", type: "song", rawText: "a\nb" } });
    const songs = (await app.inject({ method: "GET", url: "/api/v1/pipgm/items?type=song" })).json();
    assert.equal(songs.total, 1);
    const byDate = (await app.inject({ method: "GET", url: "/api/v1/pipgm/items?usedFrom=2026-11-29&usedTo=2026-11-30&type=jingle" })).json();
    assert.equal(byDate.items.length, 1);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/pipgm/items?usedFrom=x" })).statusCode, 422);
    const patched = await app.inject({ method: "PATCH", url: `/api/v1/pipgm/items/${byDate.items[0].id}`, payload: { title: "Kellot", type: null } });
    assert.equal(patched.json().title, "Kellot");
    assert.equal(patched.json().type, undefined);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/v1/pipgm/items/nope", payload: { title: "x" } })).statusCode, 404);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/v1/pipgm/items/${byDate.items[0].id}`, payload: { type: "A B" } })).statusCode, 422);
  } finally {
    await app.close();
  }
});

test("active folder: by date, by hand, and a playlist from it", async () => {
  const app = buildPipgmServer();
  try {
    const hymn = (await app.inject({ method: "POST", url: "/api/v1/pipgm/items/hymn", payload: { title: "Virsi", rawText: "a" } })).json();
    const img = (await app.inject({ method: "POST", url: "/api/v1/pipgm/items/media", payload: { kind: "image", filename: "a.png", dataBase64: "AA==" } })).json();
    const snd = (await app.inject({ method: "POST", url: "/api/v1/pipgm/items/media", payload: { kind: "audio", filename: "s.mp3", mimeType: "audio/mpeg", dataBase64: "AA==" } })).json();
    for (const [id, d] of [[hymn.id, "2026-11-29"], [snd.id, "2026-11-29"]]) {
      await app.inject({ method: "PUT", url: `/api/v1/pipgm/items/${id}/use-at`, payload: { useAt: d } });
    }
    let view = (await app.inject({ method: "GET", url: "/api/v1/pipgm/library/active?date=2026-11-29" })).json();
    assert.deepEqual(view.items.map((e: { reason: string }) => e.reason), ["date", "date"]);
    const put = await app.inject({ method: "PUT", url: `/api/v1/pipgm/library/active/${img.id}` });
    assert.equal(put.statusCode, 200);
    assert.equal((await app.inject({ method: "PUT", url: "/api/v1/pipgm/library/active/nope" })).statusCode, 404);
    view = (await app.inject({ method: "GET", url: "/api/v1/pipgm/library/active?date=2026-11-29" })).json();
    assert.equal(view.manualCount, 1);
    assert.equal(view.items.find((e: { item: { id: string } }) => e.item.id === img.id).reason, "manual");
    const pl = await app.inject({ method: "POST", url: "/api/v1/pipgm/library/active/playlist", payload: { name: "Sunnuntai", date: "2026-11-29" } });
    assert.equal(pl.statusCode, 201);
    assert.equal(pl.json().skippedAudio, 1);
    assert.deepEqual(pl.json().playlist.items.map((i: { itemId: string }) => i.itemId), [hymn.id, img.id]);
    const only = await app.inject({ method: "POST", url: "/api/v1/pipgm/library/active/playlist", payload: { name: "X", date: "2026-11-29", itemIds: [img.id, hymn.id] } });
    assert.deepEqual(only.json().playlist.items.map((i: { itemId: string }) => i.itemId), [img.id, hymn.id]);
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/pipgm/library/active/playlist", payload: { name: "X", date: "2026-11-29", itemIds: ["zzz"] } })).statusCode, 422);
    const del = await app.inject({ method: "DELETE", url: `/api/v1/pipgm/library/active/${img.id}` });
    assert.equal(del.json().manualCount, 0);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/pipgm/library/active?date=bad" })).statusCode, 422);
  } finally {
    await app.close();
  }
});

let haveFfmpeg = true;
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
} catch {
  haveFfmpeg = false;
}

test("an ogg upload is converted to mp3 with its length", { skip: !haveFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "piprogram-test-"));
  try {
    const ogg = join(dir, "t.ogg");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libvorbis", ogg]);
    const app = buildPipgmServer({ audioNormaliser: ffmpegAudioNormaliser() });
    try {
      const res = await app.inject({ method: "POST", url: "/api/v1/pipgm/items/media", payload: { kind: "audio", filename: "tone.ogg", mimeType: "audio/ogg", dataBase64: readFileSync(ogg).toString("base64") } });
      assert.equal(res.statusCode, 201, res.body);
      const body = res.json();
      assert.equal(body.audio.mimeType, "audio/mpeg");
      assert.equal(body.audio.filename, "tone.mp3");
      assert.ok(body.audio.durationMs > 1800 && body.audio.durationMs < 2300, String(body.audio.durationMs));
      const junk = await app.inject({ method: "POST", url: "/api/v1/pipgm/items/media", payload: { kind: "audio", filename: "x.mp3", mimeType: "audio/mpeg", dataBase64: Buffer.from("not audio").toString("base64") } });
      assert.equal(junk.statusCode, 422);
      assert.equal(junk.json().error.code, "AUDIO_UNREADABLE");
    } finally {
      await app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hymnal prefixes filter hymn items; no prefix is the Virsikirja", async () => {
  const hymn = (id: string, number: string) => item({ id, kind: "hymn", hymn: { hymnNumber: number, title: id, includeTitleSlide: false, stanzas: [] } });
  const all = [hymn("a", "123"), hymn("b", "VK 5"), hymn("c", "LV 12"), item({ id: "d", kind: "image" })];
  assert.deepEqual(queryLibrary(all, { hymnals: ["VK"] }).items.map((i) => i.id).sort(), ["a", "b"]);
  assert.deepEqual(queryLibrary(all, { hymnals: ["lv"] }).items.map((i) => i.id), ["c"]);
  assert.deepEqual(queryLibrary(all, { hymnals: ["VK"], types: ["hymn"] }).hymnals, [{ prefix: "LV", count: 1 }, { prefix: "VK", count: 2 }]);

  const app = buildPipgmServer({ hymnals: [{ prefix: "VK", name: "Virsikirja" }, { prefix: "LV", name: "Lasten virsi" }] });
  try {
    const made = await app.inject({ method: "POST", url: "/api/v1/pipgm/items/hymn", payload: { title: "Kiitos", hymnNumber: "lv3", rawText: "a\nb\n\nc" } });
    assert.equal(made.json().hymn.hymnNumber, "LV 3");
    assert.equal(made.json().steps.length, 2); // one step per stanza
    await app.inject({ method: "POST", url: "/api/v1/pipgm/items/hymn", payload: { title: "Hoosianna", hymnNumber: "1", rawText: "x" } });
    const lv = (await app.inject({ method: "GET", url: "/api/v1/pipgm/items?hymnal=LV" })).json();
    assert.equal(lv.total, 1);
    assert.deepEqual(lv.hymnals, [{ prefix: "LV", count: 1 }, { prefix: "VK", count: 1 }]);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/pipgm/items?hymnal=1" })).statusCode, 422);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/pipgm/hymnals" })).json().hymnals.length, 2);
  } finally {
    await app.close();
  }
});
