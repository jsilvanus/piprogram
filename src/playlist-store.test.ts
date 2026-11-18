import assert from "node:assert/strict";
import test from "node:test";
import { MemoryBlobStore } from "./library-store.js";
import { PlaylistStore, PLAYLIST_SCHEMA, savedItemOf, validatePlaylist } from "./playlist-store.js";

const doc = { schema: PLAYLIST_SCHEMA, name: "Sunday", items: [{ itemId: "hymn-1", kind: "hymn", title: "Virsi 336", hymn: { number: 336 } }, { itemId: "pptx-2" }] } as const;

test("validatePlaylist accepts a good document and drops unknown fields", () => {
  const r = validatePlaylist({ ...doc, orientation: "portrait", extra: 1, id: "x" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.orientation, "portrait");
    assert.equal(r.value.items.length, 2);
    assert.equal("extra" in r.value, false);
  }
});

test("validatePlaylist reports every problem", () => {
  const r = validatePlaylist({ schema: "other", name: " ", orientation: "square", items: [{ itemId: "" }, 5, { itemId: "a", hymn: { number: 0 } }] });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.errors.length, 6);
    assert.ok(r.errors.some((e) => e.includes("items[0].itemId")));
  }
  assert.equal(validatePlaylist("x").ok, false);
  assert.equal(validatePlaylist({ name: "a", items: "no" }).ok, false);
});

test("the store saves, lists newest first, reads, replaces and deletes", async () => {
  let t = Date.parse("2026-11-18T10:00:00Z");
  const blobs = new MemoryBlobStore();
  const store = new PlaylistStore(blobs, "p/playlists", () => (t += 1000));
  const a = (await store.save({ ...doc, items: [...doc.items] }))!;
  const b = (await store.save({ schema: PLAYLIST_SCHEMA, name: "Other", items: [] }))!;
  assert.match(a.id, /^pl-[0-9a-f]{12}$/);
  assert.ok(blobs.objects.has(`p/playlists/${a.id}.json`));
  assert.deepEqual((await store.list()).map((s) => [s.name, s.itemCount]), [["Other", 0], ["Sunday", 2]]);
  assert.deepEqual((await store.get(a.id))?.items[0]?.hymn, { number: 336 });
  const replaced = await store.save({ schema: PLAYLIST_SCHEMA, name: "Sunday 2", items: [] }, a.id);
  assert.equal(replaced?.id, a.id);
  assert.equal((await store.get(a.id))?.name, "Sunday 2");
  assert.equal(await store.save({ schema: PLAYLIST_SCHEMA, name: "x", items: [] }, "pl-000000000000"), null);
  assert.equal(await store.delete(b.id), true);
  assert.equal(await store.delete(b.id), false);
  assert.equal(await store.get("../etc"), null);
});

test("an unreadable document is left out of the list, and a down store throws", async () => {
  const blobs = new MemoryBlobStore();
  const store = new PlaylistStore(blobs, "p");
  const a = (await store.save({ ...doc, items: [...doc.items] }))!;
  blobs.objects.set("p/pl-aaaaaaaaaaaa.json", Buffer.from("{nope"));
  assert.deepEqual((await store.list()).map((s) => s.id), [a.id]);
  blobs.failing = true;
  await assert.rejects(store.list());
});

test("savedItemOf records the hymn number", () => {
  const item = { id: "hymn-3", title: "Virsi 12", kind: "hymn", createdAt: "", steps: [], hymn: { hymnNumber: "12", title: "x", includeTitleSlide: false, stanzas: [] } } as never;
  assert.deepEqual(savedItemOf(item), { itemId: "hymn-3", kind: "hymn", title: "Virsi 12", hymn: { number: 12 } });
});

test("pause markers and advanceSeconds are validated and survive a save and read", async () => {
  const good = validatePlaylist({
    name: "P",
    items: [{ itemId: "hymn-1", advanceSeconds: 90 }, { pause: true, label: "Sermon" }, { pause: true }]
  });
  assert.equal(good.ok, true);
  const store = new PlaylistStore(new MemoryBlobStore(), "p");
  if (good.ok) {
    const saved = (await store.save(good.value))!;
    assert.deepEqual((await store.get(saved.id))?.items, [{ itemId: "hymn-1", advanceSeconds: 90 }, { pause: true, label: "Sermon" }, { pause: true }]);
  }
  const bad = validatePlaylist({
    name: "P",
    items: [{}, { itemId: "a", pause: true }, { pause: false }, { pause: true, advanceSeconds: 5 }, { itemId: "a", advanceSeconds: 0 }, { itemId: "a", advanceSeconds: 5000 }, { itemId: "a", label: "x" }]
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.errors.length, 7);
});
