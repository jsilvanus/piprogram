import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import { numberPages, pagesFromZip } from "./canva-package.js";
import { LibraryPersistence, MemoryBlobStore } from "./library-store.js";
import { buildPipgmServer } from "./server.js";
import { readZip, ZipError } from "./zip.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A zip writer for tests: entries are [name, bytes, deflate?]. CRCs are left at 0 (the reader does not check them). */
function makeZip(entries: Array<[string, Buffer, boolean?]>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data, deflate] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const body = deflate ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x800, 8);
    dir.writeUInt16LE(deflate ? 8 : 0, 10);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBytes, end]);
}

test("the zip reader reads stored and deflated entries and refuses what is wrong", () => {
  const zip = makeZip([
    ["a.txt", Buffer.from("hello"), false],
    ["dir/b.txt", Buffer.from("x".repeat(1000)), true],
    ["folder/", Buffer.alloc(0), false]
  ]);
  const entries = readZip(zip);
  assert.deepEqual(entries.map((e) => e.name), ["a.txt", "dir/b.txt"]);
  assert.equal(entries[0]!.data.toString(), "hello");
  assert.equal(entries[1]!.data.length, 1000);
  assert.throws(() => readZip(Buffer.from("not a zip at all, just text, long enough to search")), ZipError);
  assert.throws(() => readZip(zip, { maxEntries: 1, maxEntryBytes: 1e6, maxTotalBytes: 1e6 }), /more than 1 entries/);
  assert.throws(() => readZip(zip, { maxEntries: 9, maxEntryBytes: 100, maxTotalBytes: 1e6 }), /larger than 100 bytes/);
  assert.throws(() => readZip(zip, { maxEntries: 9, maxEntryBytes: 1e6, maxTotalBytes: 500 }), /unpacked/);
});

test("pages are numbered by the number in the file name, and junk is ignored", () => {
  const img = Buffer.from("i");
  const zip = makeZip([
    ["Deck/page-10.png", img],
    ["Deck/page-2.png", img],
    ["Deck/page-1.PNG", img],
    ["__MACOSX/Deck/page-1.png", img],
    ["Deck/.hidden.png", img],
    ["Deck/notes.txt", img]
  ]);
  const pages = pagesFromZip(zip);
  assert.deepEqual(pages.map((p) => [p.pageNumber, p.filename, p.mimeType]), [
    [1, "page-1.PNG", "image/png"],
    [2, "page-2.png", "image/png"],
    [10, "page-10.png", "image/png"]
  ]);
  const unnumbered = numberPages([
    { filename: "b.jpg", mimeType: "image/jpeg", data: img },
    { filename: "a.jpg", mimeType: "image/jpeg", data: img }
  ]);
  assert.deepEqual(unnumbered.map((p) => [p.pageNumber, p.filename]), [[1, "a.jpg"], [2, "b.jpg"]]);
});

function newApp(store = new MemoryBlobStore(), extra: Record<string, unknown> = {}) {
  const seen: string[] = [];
  const app = buildPipgmServer({
    ttsEngine: undefined,
    stepStore: store,
    libraryStore: new LibraryPersistence(store),
    packagePollMs: 5,
    frameRenderer: async ({ html }) => {
      seen.push(html);
      return Buffer.from("png");
    },
    thumbnailer: async () => Buffer.from("jpg"),
    ...extra
  });
  return { app, seen, store };
}

async function newCanva(app: ReturnType<typeof newApp>["app"]) {
  const res = await app.inject({ method: "POST", url: "/api/v1/pipgm/items/canva", payload: { designId: "DAF123", title: "Esitys" } });
  assert.equal(res.statusCode, 201);
  return res.json() as { id: string };
}

async function untilDone(app: ReturnType<typeof newApp>["app"], taskId: string) {
  const progress: number[] = [];
  for (let i = 0; i < 200; i += 1) {
    const task = (await app.inject({ url: `/api/v1/pipgm/tasks/${taskId}` })).json() as { state: string; progress: number };
    progress.push(task.progress);
    if (task.state === "ready" || task.state === "failed") return { task: task as Record<string, unknown>, progress };
    await sleep(5);
  }
  throw new Error("task did not finish");
}

test("a zip package returns a task id; the task goes through unpacking and preparing to ready", async () => {
  const { app, seen, store } = newApp();
  await app.ready();
  const item = await newCanva(app);
  const zip = makeZip([
    ["page-1.png", Buffer.from("one")],
    ["page-2.png", Buffer.from("two"), true],
    ["page-3.jpg", Buffer.from("three")]
  ]);
  const res = await app.inject({ method: "POST", url: `/api/v1/pipgm/items/${item.id}/canva/export-package`, headers: { "content-type": "application/zip" }, payload: zip });
  assert.equal(res.statusCode, 202);
  const accepted = res.json() as { taskId: string; state: string };
  assert.equal(res.headers.location, `/api/v1/pipgm/tasks/${accepted.taskId}`);
  assert.ok(["queued", "unpacking", "preparing"].includes(accepted.state));

  const { task, progress } = await untilDone(app, accepted.taskId);
  assert.equal(task.state, "ready");
  assert.equal(task.ready, true);
  assert.deepEqual(task.pages, { total: 3 });
  assert.deepEqual(task.pictures, { done: 3, total: 3 });
  assert.equal(task.progress, 1);
  assert.deepEqual(progress, [...progress].sort((a, b) => a - b), "progress never goes back");

  const full = (await app.inject({ url: `/api/v1/pipgm/items/${item.id}` })).json() as { canva: { mode: string; pages: Array<{ assetUrl: string }> }; steps: unknown[] };
  assert.equal(full.canva.mode, "exported_slides");
  assert.equal(full.steps.length, 3);
  const page2 = await app.inject({ url: full.canva.pages[1]!.assetUrl });
  assert.equal(page2.body, "two");
  const steps = (await app.inject({ url: `/api/v1/pipgm/items/${item.id}/steps` })).json() as { steps: Array<{ prepared: boolean; thumbnailUrl?: string }> };
  assert.ok(steps.steps.every((s) => s.prepared && s.thumbnailUrl));
  assert.ok(seen.every((html) => html.includes('<base href="http://127.0.0.1:3200/">')), "relative asset URLs resolve against this server");

  // the item and its three page images are stored; saving is reported separately from ready
  await sleep(20);
  const final = (await app.inject({ url: `/api/v1/pipgm/tasks/${accepted.taskId}` })).json() as { saved: boolean };
  assert.equal(final.saved, true);
  assert.equal([...store.objects.keys()].filter((k) => k.startsWith("piprogram/library/assets/")).length, 3);
  await app.close();
});

test("the package files and the item get a retention deadline in the store", async () => {
  const store = new MemoryBlobStore();
  const { app } = newApp(store, { canvaRetentionDays: 60 });
  await app.ready();
  const item = await newCanva(app);
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/pipgm/items/${item.id}/canva/export-package`,
    payload: { pages: [{ filename: "p1.png", dataBase64: Buffer.from("a").toString("base64") }] }
  });
  assert.equal(res.statusCode, 202);
  await untilDone(app, (res.json() as { taskId: string }).taskId);
  await sleep(20);
  const library = [...store.writeOptions].filter(([k]) => k.startsWith("piprogram/library/"));
  const expiring = library.filter(([, o]) => o?.expiresAt);
  assert.ok(expiring.length >= 2, "the page file and the item JSON expire");
  const days = (Date.parse(expiring[0]![1]!.expiresAt!) - Date.now()) / 86_400_000;
  assert.ok(days > 59.9 && days < 60.1);
  await app.close();
});

test("JSON pages with explicit numbers, and the errors", async () => {
  const { app } = newApp();
  await app.ready();
  const item = await newCanva(app);
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const ok = await app.inject({
    method: "POST",
    url: `/api/v1/pipgm/items/${item.id}/canva/export-package?orientation=landscape,portrait`,
    payload: { pages: [{ filename: "b.png", pageNumber: 2, dataBase64: b64("2") }, { filename: "a.png", pageNumber: 1, dataBase64: b64("1") }] }
  });
  assert.equal(ok.statusCode, 202);
  const { task } = await untilDone(app, (ok.json() as { taskId: string }).taskId);
  assert.equal(task.state, "ready");
  assert.deepEqual(task.pictures, { done: 4, total: 4 }, "two pages in two orientations");
  const full = (await app.inject({ url: `/api/v1/pipgm/items/${item.id}` })).json() as { canva: { pages: Array<{ pageNumber: number; title: string }> } };
  assert.deepEqual(full.canva.pages.map((p) => [p.pageNumber, p.title]), [[1, "a"], [2, "b"]]);

  const url = (id: string) => `/api/v1/pipgm/items/${id}/canva/export-package`;
  assert.equal((await app.inject({ method: "POST", url: url("nope"), payload: { pages: [{ filename: "a.png", dataBase64: "AA==" }] } })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: url(item.id), payload: {} })).statusCode, 422);
  assert.equal((await app.inject({ method: "POST", url: url(item.id), payload: { pages: [{ filename: "a.txt", dataBase64: "AA==" }] } })).statusCode, 422);
  assert.equal((await app.inject({ method: "POST", url: `${url(item.id)}?orientation=square`, payload: { pages: [{ filename: "a.png", dataBase64: "AA==" }] } })).statusCode, 422);
  const hymn = (await app.inject({ method: "POST", url: "/api/v1/pipgm/items/hymn", payload: { title: "V", stanzas: [{ lines: ["a"] }] } })).json() as { id: string };
  assert.equal((await app.inject({ method: "POST", url: url(hymn.id), payload: { pages: [{ filename: "a.png", dataBase64: "AA==" }] } })).statusCode, 422);
  assert.equal((await app.inject({ url: "/api/v1/pipgm/tasks/none" })).statusCode, 404);
  await app.close();
});

test("a zip without images ends as a failed task with the reason", async () => {
  const { app } = newApp();
  await app.ready();
  const item = await newCanva(app);
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/pipgm/items/${item.id}/canva/export-package`,
    headers: { "content-type": "application/zip" },
    payload: makeZip([["readme.txt", Buffer.from("hi")]])
  });
  const { task } = await untilDone(app, (res.json() as { taskId: string }).taskId);
  assert.equal(task.state, "failed");
  assert.match(String(task.error), /no page images/);
  const broken = await app.inject({ method: "POST", url: `/api/v1/pipgm/items/${item.id}/canva/export-package`, headers: { "content-type": "application/zip" }, payload: Buffer.from("garbage garbage garbage garbage") });
  const second = await untilDone(app, (broken.json() as { taskId: string }).taskId);
  assert.equal(second.task.state, "failed");
  assert.match(String(second.task.error), /not a zip/);
  await app.close();
});

test("useAt: set at creation, set later, cleared, refused; every stored file and the step pictures carry it", async () => {
  const store = new MemoryBlobStore();
  const { app } = newApp(store);
  await app.ready();

  const bad = await app.inject({ method: "POST", url: "/api/v1/pipgm/items/canva", payload: { designId: "DAF123", useAt: "next sunday" } });
  assert.equal(bad.statusCode, 422);
  assert.equal((bad.json() as { error: { code: string } }).error.code, "INVALID_USE_AT");

  const created = await app.inject({ method: "POST", url: "/api/v1/pipgm/items/canva", payload: { designId: "DAF123", title: "Esitys", useAt: "2026-11-08" } });
  assert.equal(created.statusCode, 201);
  const item = created.json() as { id: string; useAt: string[] };
  assert.deepEqual(item.useAt, ["2026-11-08"]);

  const res = await app.inject({
    method: "POST",
    url: `/api/v1/pipgm/items/${item.id}/canva/export-package`,
    payload: { pages: [{ filename: "p1.png", dataBase64: Buffer.from("a").toString("base64") }] }
  });
  await untilDone(app, (res.json() as { taskId: string }).taskId);
  await sleep(20);
  const written = [...store.writeOptions];
  assert.ok(written.length >= 4, "page file, item JSON, step picture and thumbnail");
  for (const [key, options] of written) assert.deepEqual(options?.useAt, ["2026-11-08"], key);

  const changed = await app.inject({ method: "PUT", url: `/api/v1/pipgm/items/${item.id}/use-at`, payload: { useAt: ["2026-11-15/2026-11-16", "2026-11-22T10"] } });
  assert.equal(changed.statusCode, 200);
  assert.deepEqual((changed.json() as { useAt: string[] }).useAt, ["2026-11-15/2026-11-16", "2026-11-22T10"]);
  await sleep(20);
  assert.deepEqual(store.writeOptions.get(`piprogram/library/items/${item.id}.json`)?.useAt, ["2026-11-15/2026-11-16", "2026-11-22T10"]);
  const pageKey = [...store.writeOptions.keys()].find((k) => k.startsWith("piprogram/library/assets/"))!;
  assert.deepEqual(store.writeOptions.get(pageKey)?.useAt, ["2026-11-15/2026-11-16", "2026-11-22T10"]);
  assert.ok((store.writeOptions.get(pageKey)?.expiresAt ?? "") > "", "the retention deadline is kept when the date changes");
  const changedKeys = store.useAtChanges.map((c) => c.key);
  assert.ok(changedKeys.includes(pageKey), "the page file changed its date in place, without a new upload");
  assert.ok(changedKeys.some((k) => k.startsWith("piprogram/steps/") && k.endsWith(".png")), "the step picture too");
  assert.ok(changedKeys.some((k) => k.startsWith("piprogram/steps/") && k.endsWith(".thumb.jpg")), "and its thumbnail");
  assert.ok(!changedKeys.includes(`piprogram/library/items/${item.id}.json`), "the item JSON is rewritten because the date is inside it");

  assert.equal((await app.inject({ method: "PUT", url: `/api/v1/pipgm/items/${item.id}/use-at`, payload: { useAt: "x" } })).statusCode, 422);
  assert.equal((await app.inject({ method: "PUT", url: `/api/v1/pipgm/items/${item.id}/use-at`, payload: { useAt: 5 } })).statusCode, 422);
  assert.equal((await app.inject({ method: "PUT", url: `/api/v1/pipgm/items/nope/use-at`, payload: { useAt: null } })).statusCode, 404);
  const cleared = await app.inject({ method: "PUT", url: `/api/v1/pipgm/items/${item.id}/use-at`, payload: { useAt: null } });
  assert.equal((cleared.json() as { useAt?: string[] }).useAt, undefined);
  await app.close();
});
