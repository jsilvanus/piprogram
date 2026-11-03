import assert from "node:assert/strict";
import test from "node:test";
import { LibraryPersistence, MemoryBlobStore, PiStorageBlobStore } from "./library-store.js";
import { PiPgmService } from "./pipgm-service.js";
import { buildPipgmServer } from "./server.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const PNG = Buffer.from("not-really-a-png");

function newService(store: MemoryBlobStore) {
  return new PiPgmService({ libraryStore: new LibraryPersistence(store), ttsEngine: undefined });
}

test("an uploaded image is stored and comes back after a restart, with its bytes", async () => {
  const store = new MemoryBlobStore();
  const first = newService(store);
  const item = first.createUploadedMediaItem({ kind: "image", filename: "a.png", dataBase64: PNG.toString("base64") });
  await first.flushLibrary();
  assert.ok([...store.objects.keys()].some((k) => k.startsWith("piprogram/library/assets/")));
  assert.equal(first.libraryStorageStatus().unsaved.length, 0);

  const second = newService(store);
  assert.equal(await second.loadLibrary(), 1);
  const back = second.getLibraryItem(item.id);
  assert.equal(back?.title, "a.png");
  const asset = second.getAsset(back!.image!.assetId);
  assert.equal(asset?.stored, true);
  assert.deepEqual(await second.readStoredAsset(asset!.id), PNG);
});

test("ids made after a restart do not collide with stored ones", async () => {
  const store = new MemoryBlobStore();
  const first = newService(store);
  const a = first.createUploadedMediaItem({ kind: "image", filename: "a.png", dataBase64: "AA==" });
  await first.flushLibrary();
  const second = newService(store);
  await second.loadLibrary();
  const b = second.createUploadedMediaItem({ kind: "image", filename: "b.png", dataBase64: "AA==" });
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.image!.assetId, b.image!.assetId);
});

test("a write while the store is down stays unsaved and is retried", async () => {
  const store = new MemoryBlobStore();
  store.failing = true;
  const service = newService(store);
  const item = service.createUploadedMediaItem({ kind: "image", filename: "a.png", dataBase64: "AA==" });
  await sleep(10);
  assert.equal(service.libraryStorageStatus().unsaved[0]?.itemId, item.id);
  assert.match(service.libraryStorageStatus().unsaved[0]?.error ?? "", /unavailable/);
  assert.equal(await service.flushLibrary(), 1, "still down");
  store.failing = false;
  assert.equal(await service.flushLibrary(), 0);
  assert.ok(store.objects.has(`piprogram/library/items/${item.id}.json`));
});

test("hymns are stored too, and deleting an item removes its files and its playlist places", async () => {
  const store = new MemoryBlobStore();
  const service = newService(store);
  const hymn = service.createHymnItem({ title: "Virsi", stanzas: [{ lines: ["a"] }], targetPipelineId: "PiPGM1", cueImmediately: true });
  const image = service.createUploadedMediaItem({ kind: "image", filename: "a.png", dataBase64: "AA==", targetPipelineId: "PiPGM2" });
  await service.flushLibrary();
  assert.equal(store.objects.size, 3);
  assert.equal(await service.deleteLibraryItem(image.id), true);
  assert.equal(await service.deleteLibraryItem(image.id), false);
  assert.equal(store.objects.size, 1);
  assert.equal(service.getPipeline("PiPGM2")!.playlist.length, 0);
  assert.ok(service.getLibraryItem(hymn.id));
});

test("an unreadable stored entry is skipped, the rest load", async () => {
  const store = new MemoryBlobStore();
  const service = newService(store);
  service.createUploadedMediaItem({ kind: "image", filename: "a.png", dataBase64: "AA==" });
  await service.flushLibrary();
  await store.put("piprogram/library/items/broken.json", Buffer.from("{nope"));
  const skipped: string[] = [];
  const second = newService(store);
  assert.equal(await second.loadLibrary((key) => skipped.push(key)), 1);
  assert.deepEqual(skipped, ["piprogram/library/items/broken.json"]);
});

test("the server loads the stored library, serves stored bytes and reports storage status", async () => {
  const store = new MemoryBlobStore();
  const seed = newService(store);
  const item = seed.createUploadedMediaItem({ kind: "image", filename: "a.png", mimeType: "image/png", dataBase64: PNG.toString("base64") });
  await seed.flushLibrary();

  const app = buildPipgmServer({ libraryStore: new LibraryPersistence(store), ttsEngine: undefined, libraryRetryMs: 20 });
  await app.ready();
  const items = (await app.inject({ url: "/api/v1/pipgm/items" })).json() as { items: Array<{ id: string }> };
  assert.deepEqual(items.items.map((i) => i.id), [item.id]);
  const asset = await app.inject({ url: item.image!.assetUrl });
  assert.equal(asset.statusCode, 200);
  assert.equal(asset.headers["content-type"], "image/png");
  assert.equal(asset.rawPayload.toString(), PNG.toString());
  store.failing = true;
  assert.equal((await app.inject({ url: item.image!.assetUrl })).statusCode, 503);
  store.failing = false;
  const status = (await app.inject({ url: "/api/v1/pipgm/library/storage" })).json() as { enabled: boolean; loaded: boolean };
  assert.deepEqual([status.enabled, status.loaded], [true, true]);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/v1/pipgm/items/${item.id}` })).statusCode, 204);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/v1/pipgm/items/${item.id}` })).statusCode, 404);
  await app.close();
});

test("the server loads the library later when the store is down at start", async () => {
  const store = new MemoryBlobStore();
  const seed = newService(store);
  seed.createUploadedMediaItem({ kind: "image", filename: "a.png", dataBase64: "AA==" });
  await seed.flushLibrary();
  store.failing = true;
  const app = buildPipgmServer({ libraryStore: new LibraryPersistence(store), ttsEngine: undefined, libraryRetryMs: 20 });
  await app.ready();
  assert.equal(((await app.inject({ url: "/api/v1/pipgm/library/storage" })).json() as { loaded: boolean }).loaded, false);
  store.failing = false;
  await sleep(80);
  assert.equal(((await app.inject({ url: "/api/v1/pipgm/library/storage" })).json() as { loaded: boolean }).loaded, true);
  assert.equal(((await app.inject({ url: "/api/v1/pipgm/items" })).json() as { items: unknown[] }).items.length, 1);
  await app.close();
});

test("PiStorageBlobStore speaks the pistorage API with the key", async () => {
  const calls: Array<{ url: string; method: string; auth: string | null; len: string | null; expires: string | null }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    calls.push({ url, method: init.method ?? "GET", auth: headers.get("authorization"), len: headers.get("content-length"), expires: headers.get("x-pistorage-expires-at") });
    if (url.includes("/objects?")) return Response.json({ items: [{ key: "p/items/a.json" }], truncated: false });
    if (init.method === "PUT") return new Response("{}", { status: 201 });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return url.endsWith("missing") ? new Response("{}", { status: 404 }) : new Response(Buffer.from("xyz"));
  }) as unknown as typeof fetch;
  const store = new PiStorageBlobStore({ baseUrl: "http://pi:3700/", apiKey: "k", fetch: fakeFetch });
  await store.put("p/assets/a b", Buffer.from("xyz"), { contentType: "image/png", expiresAt: "2030-01-01T00:00:00Z" });
  assert.equal(calls[0]!.url, "http://pi:3700/api/v1/objects/p/assets/a%20b");
  assert.equal(calls[0]!.auth, "Bearer k");
  assert.equal(calls[0]!.len, "3");
  assert.equal(calls[0]!.expires, "2030-01-01T00:00:00Z");
  assert.deepEqual(await store.get("p/assets/x"), Buffer.from("xyz"));
  assert.equal(await store.get("p/assets/missing"), null);
  assert.deepEqual(await store.list("p/items/"), ["p/items/a.json"]);
  await store.delete("p/assets/x");
  assert.equal(calls.at(-1)!.method, "DELETE");
});
