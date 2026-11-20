import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { PipgmFeeders } from "./feeder.js";
import { MemoryBlobStore } from "./library-store.js";
import { PiPgmService } from "./pipgm-service.js";
import { buildPipgmServer } from "./server.js";
import { itemVersion, resolveStandardVariant, StepImages } from "./step-cache.js";

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

function makeTestPng(width: number, height: number, color = "blue@0.5"): Buffer {
  const res = spawnSync(
    process.env.PIPGM_FFMPEG?.trim() || "ffmpeg",
    ["-y", "-f", "lavfi", "-i", `color=c=${color}:s=${width}x${height},format=rgba`, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"],
    { encoding: "buffer" }
  );
  if (res.status !== 0 || !res.stdout?.length) throw new Error(`failed to create test PNG: ${res.stderr?.toString()}`);
  return res.stdout;
}

function pngDimensions(buf: Buffer): { width: number; height: number } {
  assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test("static image & exported Canva slides bypass Chromium and pre-render all variants with useAt", async () => {
  const service = new PiPgmService({ ttsEngine: undefined });
  const store = new MemoryBlobStore();
  let chromiumCalls = 0;
  const steps = new StepImages({
    store,
    snapshotForStep: (id, step, o) => service.snapshotForStep(id, step, o),
    getItem: (id) => service.getLibraryItem(id),
    getAssetBytes: (assetId) => service.readAssetBytes(assetId),
    renderFrame: async () => {
      chromiumCalls += 1;
      throw new Error("Chromium should not be called for static image or exported Canva slides");
    }
  });

  const samplePng = makeTestPng(100, 160, "red@0.5");
  const imgItem = service.createUploadedMediaItem({
    kind: "image",
    title: "Poster",
    filename: "poster.png",
    mimeType: "image/png",
    dataBase64: samplePng.toString("base64")
  });
  service.setUseAt(imgItem.id, ["2026-12-24"]);

  steps.prepare(imgItem.id, "portrait");
  await finished(steps, imgItem.id, "portrait");
  assert.equal(chromiumCalls, 0, "Chromium was bypassed");

  const v916 = await steps.variantImage(imgItem.id, 0, "9:16");
  const vPortrait = await steps.image(imgItem.id, 0, "portrait");
  const v1016 = await steps.variantImage(imgItem.id, 0, "10:16");
  const vLand = await steps.variantImage(imgItem.id, 0, "landscape");
  const vChromaLeft = await steps.variantImage(imgItem.id, 0, "chroma-left");
  const vChromaRight = await steps.variantImage(imgItem.id, 0, "chroma-right");
  const vRgbaLeft = await steps.variantImage(imgItem.id, 0, "rgba-left");
  const vRgbaRight = await steps.variantImage(imgItem.id, 0, "rgba-right");
  const thumb = await steps.thumbnail(imgItem.id, 0, "portrait");

  assert.ok(v916 && vPortrait && v916.equals(vPortrait));
  assert.deepEqual(pngDimensions(v916!), { width: 1080, height: 1920 });
  assert.deepEqual(pngDimensions(v1016!), { width: 1200, height: 1920 });
  assert.deepEqual(pngDimensions(vLand!), { width: 1920, height: 1080 });
  assert.deepEqual(pngDimensions(vChromaLeft!), { width: 1920, height: 1080 });
  assert.deepEqual(pngDimensions(vChromaRight!), { width: 1920, height: 1080 });
  assert.deepEqual(pngDimensions(vRgbaLeft!), { width: 1920, height: 1080 });
  assert.deepEqual(pngDimensions(vRgbaRight!), { width: 1920, height: 1080 });
  assert.ok(thumb && thumb.length > 0);

  // Verify useAt metadata is preserved on all stored variants
  const storedKeys = [...store.objects.keys()].filter((k) => k.includes(imgItem.id));
  assert.ok(storedKeys.length >= 9);
  for (const k of storedKeys) {
    assert.deepEqual(store.writeOptions.get(k)?.useAt, ["2026-12-24"]);
  }

  // Verify lookupVariant with options
  const snap = service.snapshotForStep(imgItem.id, 0, "portrait")!;
  const matchedChroma = await steps.lookupVariant(snap, { keyMode: "chroma", side: "right", keyColor: "#00ff00", slideScale: 1, offsetY: 0 });
  assert.ok(matchedChroma && matchedChroma.equals(vChromaRight!));

  // Verify custom placement render without Chromium
  const custom = await steps.renderCustomVariant(imgItem.id, 0, { keyMode: "chroma", keyColor: "#0000ff", slideScale: 0.8, offsetX: -0.5, offsetY: 0.25 });
  assert.ok(custom);
  assert.deepEqual(pngDimensions(custom!), { width: 1920, height: 1080 });
});

test("frame.png route serves pre-rendered variants from StepImages cache without Chromium", async () => {
  const store = new MemoryBlobStore();
  let chromiumCalls = 0;
  const app = buildPipgmServer({
    ttsEngine: undefined,
    stepStore: store,
    frameRenderer: async () => {
      chromiumCalls += 1;
      return makeTestPng(1080, 1920);
    }
  });

  const samplePng = makeTestPng(90, 160, "green@1");
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/v1/pipgm/items/media",
      payload: { kind: "image", filename: "slide.png", mimeType: "image/png", dataBase64: samplePng.toString("base64"), targetPipelineId: "PiPGM1", cueImmediately: true }
    })
  ).json() as { id: string };

  await app.inject({ method: "POST", url: `/api/v1/pipgm/items/${created.id}/prepare`, payload: { orientation: "portrait" } });
  for (let i = 0; i < 60; i += 1) {
    await sleep(25);
    const st = (await app.inject({ url: `/api/v1/pipgm/items/${created.id}/steps?orientation=portrait` })).json() as { prepare: { state: string } };
    if (st.prepare.state !== "running") break;
  }

  const resPortrait = await app.inject({ url: "/api/v1/pipgm/pipelines/PiPGM1/frame.png" });
  assert.equal(resPortrait.statusCode, 200);
  assert.deepEqual(pngDimensions(resPortrait.rawPayload), { width: 1080, height: 1920 });

  const resChroma = await app.inject({ url: "/api/v1/pipgm/pipelines/PiPGM1/frame.png?side=left&keyMode=chroma&keyColor=%2300ff00&slideScale=1&offsetX=-1&offsetY=0" });
  assert.equal(resChroma.statusCode, 200);
  assert.equal(resChroma.headers["x-piprogram-composited"], "1");
  assert.deepEqual(pngDimensions(resChroma.rawPayload), { width: 1920, height: 1080 });

  const res1016 = await app.inject({ url: "/api/v1/pipgm/pipelines/PiPGM1/frame.png?variant=10:16" });
  assert.equal(res1016.statusCode, 200);
  assert.deepEqual(pngDimensions(res1016.rawPayload), { width: 1200, height: 1920 });

  assert.equal(chromiumCalls, 0, "Chromium was never spawned");
  await app.close();
});

test("resolveStandardVariant rejects custom offsetX, side, keyMode, and slideAspect overrides on variant", () => {
  assert.equal(resolveStandardVariant({ variant: "chroma-left" }), "chroma-left");
  assert.equal(resolveStandardVariant({ variant: "chroma-left", side: "left", offsetX: -1, keyMode: "chroma", keyColor: "#00ff00" }), "chroma-left");
  assert.equal(resolveStandardVariant({ variant: "chroma-left", offsetX: 0.5 }), null);
  assert.equal(resolveStandardVariant({ variant: "chroma-left", side: "right" }), null);
  assert.equal(resolveStandardVariant({ variant: "chroma-left", keyMode: "rgba" }), null);
  assert.equal(resolveStandardVariant({ variant: "chroma-left", slideAspect: "10:16" }), null);
});

test("renderCustomVariant returns null for unsupported base image bytes without calling ffmpeg", async () => {
  const service = new PiPgmService({ ttsEngine: undefined });
  const store = new MemoryBlobStore();
  const steps = new StepImages({
    store,
    snapshotForStep: (id, step, o) => service.snapshotForStep(id, step, o),
    getItem: (id) => service.getLibraryItem(id),
    renderFrame: async () => Buffer.from("not-an-image"),
    thumbnailer: async () => Buffer.from("thumb")
  });
  const hymn = service.createHymnItem({ title: "V", stanzas: [{ lines: ["a"] }] });
  const snap = service.snapshotForStep(hymn.id, 0, "portrait")!;
  await steps.remember(snap, Buffer.from("not-an-image"));
  assert.equal(await steps.renderCustomVariant(hymn.id, 0, { keyMode: "chroma" }), null);
});

test("prepare after remember generates missing key variants and landscape HTML uses transparent portrait for key variants", async () => {
  const service = new PiPgmService({ ttsEngine: undefined });
  const store = new MemoryBlobStore();
  const calls: Array<{ width: number; height: number; transparent: boolean }> = [];
  const realPortrait = makeTestPng(1080, 1920, "blue@0.5");
  const realLandscape = makeTestPng(1920, 1080, "black@1");
  const steps = new StepImages({
    store,
    snapshotForStep: (id, step, o) => service.snapshotForStep(id, step, o),
    getItem: (id) => service.getLibraryItem(id),
    renderFrame: async ({ width, height, transparent }) => {
      calls.push({ width, height, transparent: Boolean(transparent) });
      return width === 1920 ? realLandscape : realPortrait;
    }
  });

  const hymn = service.createHymnItem({ title: "Hymn", stanzas: [{ lines: ["line 1"] }] });
  const landSnap = service.snapshotForStep(hymn.id, 0, "landscape")!;
  await steps.remember(landSnap, realLandscape);
  assert.equal(await steps.variantImage(hymn.id, 0, "chroma-left"), null, "remember alone did not generate variants");

  steps.prepare(hymn.id, "landscape");
  const done = await finished(steps, hymn.id, "landscape");
  assert.equal(done.state, "done");
  assert.ok(await steps.variantImage(hymn.id, 0, "chroma-left"), "prepare generated missing chroma-left after remember");
  assert.ok(await steps.variantImage(hymn.id, 0, "rgba-left"), "prepare generated missing rgba-left after remember");
  assert.ok(
    calls.some((c) => c.width === 1080 && c.height === 1920 && c.transparent === true),
    "key variants were derived from transparent portrait render"
  );
});

test("frame.png cache miss for composite query renders transparent native slide and composites (or falls back transparent)", async () => {
  const store = new MemoryBlobStore();
  const renderCalls: Array<{ width: number; height: number; transparent: boolean }> = [];
  const realPortrait = makeTestPng(1080, 1920, "red@0.5");
  const app = buildPipgmServer({
    ttsEngine: undefined,
    stepStore: store,
    frameRenderer: async ({ width, height, transparent }) => {
      renderCalls.push({ width, height, transparent: Boolean(transparent) });
      return realPortrait;
    }
  });

  const hymn = (
    await app.inject({
      method: "POST",
      url: "/api/v1/pipgm/items/hymn",
      payload: { title: "H", stanzas: [{ lines: ["a"] }], targetPipelineId: "PiPGM1", cueImmediately: true }
    })
  ).json() as { id: string };
  assert.ok(hymn.id);

  const res = await app.inject({ url: "/api/v1/pipgm/pipelines/PiPGM1/frame.png?keyColor=%230000ff" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-piprogram-composited"], "1");
  assert.deepEqual(pngDimensions(res.rawPayload), { width: 1920, height: 1080 }, "keyColor without variant/width defaults to 1920x1080");
  assert.equal(renderCalls[0]?.transparent, true, "fallback rendered transparent slide");
  await app.close();
});
