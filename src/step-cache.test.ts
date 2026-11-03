import assert from "node:assert/strict";
import test from "node:test";
import { PipgmFeeders } from "./feeder.js";
import { MemoryBlobStore } from "./library-store.js";
import { PiPgmService } from "./pipgm-service.js";
import { buildPipgmServer } from "./server.js";
import { itemVersion, StepImages } from "./step-cache.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setup() {
  const service = new PiPgmService({ ttsEngine: undefined });
  const store = new MemoryBlobStore();
  const renders: string[] = [];
  const steps = new StepImages({
    store,
    snapshotForStep: (id, step, o) => service.snapshotForStep(id, step, o),
    getItem: (id) => service.getLibraryItem(id),
    renderFrame: async ({ html, width }) => {
      renders.push(`${width}`);
      return Buffer.from(`png:${width}:${/"currentStep":(\d+)/.exec(html)?.[1]}`);
    },
    thumbnailer: async (png) => Buffer.from(`thumb(${png.toString()})`)
  });
  const hymn = service.createHymnItem({ title: "Virsi", stanzas: [{ lines: ["a"] }, { lines: ["b"] }, { lines: ["c"] }] });
  return { service, store, steps, renders, hymn };
}

async function finished(steps: StepImages, id: string, orientation: "landscape" | "portrait" = "landscape") {
  for (let i = 0; i < 50; i += 1) {
    const s = steps.status(id, orientation);
    if (s.state !== "running") return s;
    await sleep(5);
  }
  throw new Error("prepare did not finish");
}

test("prepare renders every step once, stores the picture and a thumbnail, and skips what is stored", async () => {
  const { steps, renders, hymn } = setup();
  const started = steps.prepare(hymn.id, "landscape");
  assert.notEqual(typeof started, "string");
  const done = await finished(steps, hymn.id);
  assert.deepEqual([done.state, done.done, done.total], ["done", hymn.steps.length, hymn.steps.length]);
  assert.equal(renders.length, hymn.steps.length);
  assert.equal((await steps.image(hymn.id, 1, "landscape"))?.toString(), "png:1920:1");
  assert.equal((await steps.thumbnail(hymn.id, 1, "landscape"))?.toString(), "thumb(png:1920:1)");
  assert.equal(await steps.image(hymn.id, 1, "portrait"), null, "another size is another picture");
  const list = await steps.steps(hymn.id, "landscape");
  assert.ok(list!.every((s) => s.prepared));

  steps.prepare(hymn.id, "landscape");
  await finished(steps, hymn.id);
  assert.equal(renders.length, hymn.steps.length, "nothing rendered again");
});

test("an edited item has a new version, so an old picture is not served, and old versions are removed", async () => {
  const { service, store, steps, hymn } = setup();
  steps.prepare(hymn.id, "landscape");
  await finished(steps, hymn.id);
  const before = [...store.objects.keys()].filter((k) => k.startsWith("piprogram/steps/")).length;
  const item = service.getLibraryItem(hymn.id)!;
  const edited = { ...item, steps: item.steps.map((s) => ({ ...s, label: `${s.label}!` })) };
  assert.notEqual(itemVersion(item, "landscape"), itemVersion(edited, "landscape"));
  assert.notEqual(itemVersion(item, "landscape"), itemVersion(item, "portrait"));

  const lib = (service as unknown as { library: Map<string, unknown> }).library;
  lib.set(hymn.id, edited);
  assert.equal(await steps.image(hymn.id, 0, "landscape"), null);
  steps.prepare(hymn.id, "landscape");
  await finished(steps, hymn.id);
  assert.equal([...store.objects.keys()].filter((k) => k.startsWith("piprogram/steps/")).length, before, "old version removed");
});

test("snapshotForStep shows the step without touching any real pipeline", () => {
  const { service, hymn } = setup();
  const snap = service.snapshotForStep(hymn.id, 2, "portrait")!;
  assert.equal(snap.activeItemId, hymn.id);
  assert.equal(snap.currentStep, 2);
  assert.deepEqual(snap.resolution, { width: 1080, height: 1920 });
  assert.equal(service.getPipeline("PiPGM1")!.activeItemId, null);
  assert.equal(service.snapshotForStep(hymn.id, 99, "landscape"), null);
  assert.equal(service.snapshotForStep("nope", 0, "landscape"), null);
});

test("the feeder reads a prepared picture instead of rendering, and keeps a picture it had to render", async () => {
  const { service, steps, renders, hymn } = setup();
  service.addItemToPipeline("PiPGM2", hymn.id, true);
  const shown: string[] = [];
  const feeders = new PipgmFeeders({
    service,
    rtspBase: "rtsp://x",
    fps: 50,
    steps,
    renderFrame: async () => {
      renders.push("live");
      return Buffer.from("live-render");
    },
    spawn: () => ({
      stdin: { write: (c: Buffer) => (shown.push(c.toString()), true), once: () => undefined, end: () => undefined },
      kill: () => true,
      onExit: () => undefined,
      onError: () => undefined
    })
  });
  await feeders.tick();
  assert.ok(renders.includes("live"), "nothing prepared yet: rendered");
  await sleep(30);
  assert.ok((await steps.image(hymn.id, 0, "landscape")) !== null, "and kept");

  service.control("PiPGM2", { action: "next" });
  steps.prepare(hymn.id, "landscape");
  await finished(steps, hymn.id);
  const before = renders.filter((r) => r === "live").length;
  await feeders.tick();
  assert.equal(renders.filter((r) => r === "live").length, before, "step 1 came from the store");
  await sleep(30);
  assert.ok(shown.some((s) => s.startsWith("png:1920:1")));
  feeders.stop();
});

test("routes: prepare, list with urls, serve the picture and the thumbnail, errors", async () => {
  const store = new MemoryBlobStore();
  const app = buildPipgmServer({
    ttsEngine: undefined,
    stepStore: store,
    frameRenderer: async ({ width }) => Buffer.from(`png${width}`),
    thumbnailer: async () => Buffer.from("jpg")
  });
  const hymn = (
    await app.inject({ method: "POST", url: "/api/v1/pipgm/items/hymn", payload: { title: "V", stanzas: [{ lines: ["a"] }, { lines: ["b"] }] } })
  ).json() as { id: string };
  const base = `/api/v1/pipgm/items/${hymn.id}`;
  assert.equal((await app.inject({ url: `${base}/steps/0/image.png` })).statusCode, 404);
  const listBefore = (await app.inject({ url: `${base}/steps` })).json() as { steps: Array<{ prepared: boolean }> };
  assert.ok(listBefore.steps.every((s) => !s.prepared));

  const prep = await app.inject({ method: "POST", url: `${base}/prepare`, payload: {} });
  assert.equal(prep.statusCode, 202);
  let list = { prepare: { state: "running" }, steps: [] as Array<{ prepared: boolean; imageUrl?: string; thumbnailUrl?: string }> };
  for (let i = 0; i < 50 && list.prepare.state === "running"; i += 1) {
    await sleep(5);
    list = (await app.inject({ url: `${base}/steps` })).json();
  }
  assert.equal(list.prepare.state, "done");
  assert.ok(list.steps.every((s) => s.prepared && s.imageUrl && s.thumbnailUrl));
  const img = await app.inject({ url: list.steps[0]!.imageUrl! });
  assert.deepEqual([img.statusCode, img.headers["content-type"], img.body], [200, "image/png", "png1920"]);
  const thumb = await app.inject({ url: list.steps[0]!.thumbnailUrl! });
  assert.deepEqual([thumb.statusCode, thumb.headers["content-type"], thumb.body], [200, "image/jpeg", "jpg"]);

  assert.equal((await app.inject({ method: "POST", url: "/api/v1/pipgm/items/nope/prepare", payload: {} })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: `${base}/prepare`, payload: { orientation: "square" } })).statusCode, 422);
  const sound = (
    await app.inject({ method: "POST", url: "/api/v1/pipgm/items/media", payload: { kind: "audio", filename: "a.mp3", dataBase64: "AA==" } })
  ).json() as { id: string };
  assert.equal((await app.inject({ method: "POST", url: `/api/v1/pipgm/items/${sound.id}/prepare`, payload: {} })).statusCode, 422);

  await app.inject({ method: "DELETE", url: base });
  await sleep(10);
  assert.equal([...store.objects.keys()].filter((k) => k.includes(hymn.id)).length, 0, "deleting the item removes its pictures");
  await app.close();
});
