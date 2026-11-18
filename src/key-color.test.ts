import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PipgmFeeders } from "./feeder.js";
import { PiPgmService } from "./pipgm-service.js";
import { buildPipgmServer } from "./server.js";
import { renderPiPgmStageHtml } from "./stage-html.js";
import { runCli } from "./cli.js";

function snapshotOf(service: PiPgmService, id = "PiPGM1") {
  return service.getPipeline(id)!;
}

test("the key colour is off by default and set per feed", () => {
  const service = new PiPgmService();
  assert.equal(snapshotOf(service).keyColor, null);
  service.updatePipelineConfig("PiPGM2", { keyColor: "#00B140" });
  assert.equal(snapshotOf(service, "PiPGM2").keyColor, "#00b140");
  assert.equal(snapshotOf(service, "PiPGM1").keyColor, null);
  service.updatePipelineConfig("PiPGM2", { keyColor: null });
  assert.equal(snapshotOf(service, "PiPGM2").keyColor, null);
  assert.throws(() => service.updatePipelineConfig("PiPGM1", { keyColor: "green" }));
});

test("the key colour survives a restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "piprogram-key-"));
  try {
    new PiPgmService({ cacheDir: dir }).updatePipelineConfig("PiPGM3", { keyColor: "#0047bb" });
    const again = new PiPgmService({ cacheDir: dir });
    assert.equal(snapshotOf(again, "PiPGM3").keyColor, "#0047bb");
    assert.equal(snapshotOf(again, "PiPGM1").keyColor, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stage html fills the background with the key colour, but not when transparent or unset", () => {
  const snap = snapshotOf(new PiPgmService());
  assert.ok(renderPiPgmStageHtml(snap, { keyColor: "#00b140" }).includes("background: #00b140 !important"));
  assert.ok(!renderPiPgmStageHtml(snap, {}).includes("#00b140"));
  assert.ok(!renderPiPgmStageHtml(snap, { keyColor: "red; x" }).includes("red; x"));
  assert.ok(!renderPiPgmStageHtml(snap, { keyColor: "#00b140", transparent: true }).includes("#00b140"));
});

test("config route validates and returns the key colour", async () => {
  const app = buildPipgmServer({});
  const bad = await app.inject({ method: "PUT", url: "/api/v1/pipgm/pipelines/PiPGM1/config", payload: { keyColor: "green" } });
  assert.equal(bad.statusCode, 422);
  const ok = await app.inject({ method: "PUT", url: "/api/v1/pipgm/pipelines/PiPGM1/config", payload: { keyColor: "#00B140" } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().keyColor, "#00b140");
  const off = await app.inject({ method: "PUT", url: "/api/v1/pipgm/pipelines/PiPGM1/config", payload: { keyColor: null } });
  assert.equal(off.json().keyColor, null);
  await app.close();
});

test("a keyed feed renders with the key colour and skips the prepared pictures; an unkeyed one does not", async () => {
  const service = new PiPgmService();
  service.createHymnItem({ title: "Virsi", stanzas: [{ lines: ["a"] }], targetPipelineId: "PiPGM1", cueImmediately: true });
  service.createHymnItem({ title: "Virsi", stanzas: [{ lines: ["a"] }], targetPipelineId: "PiPGM2", cueImmediately: true });
  service.updatePipelineConfig("PiPGM1", { keyColor: "#00b140" });
  const htmls: Record<string, string> = {};
  const looked: string[] = [];
  const feeders = new PipgmFeeders({
    service,
    rtspBase: "rtsp://x/",
    fps: 25,
    spawn: () => ({ stdin: { write: () => true, once: () => undefined, end: () => undefined }, kill: () => true, onExit() {}, onError() {} }) as never,
    renderFrame: async ({ html }) => {
      htmls[html.includes("#00b140") ? "keyed" : "plain"] = html;
      return Buffer.from("png");
    },
    steps: { lookup: async (snap) => (looked.push(snap.id), null), remember: async () => undefined }
  });
  await feeders.tick();
  feeders.stop();
  assert.ok(htmls.keyed, "PiPGM1 is rendered with the key colour");
  assert.ok(htmls.plain, "PiPGM2 keeps the normal background");
  assert.ok(!looked.includes("PiPGM1"), "a keyed feed never reads prepared pictures");
  assert.ok(looked.includes("PiPGM2"));
});

test("cli key sets and clears the colour", async () => {
  const app = buildPipgmServer();
  const baseUrl = (await app.listen({ host: "127.0.0.1", port: 0 })).replace(/\/$/, "");
  const lines: string[] = [];
  const errors: string[] = [];
  const io = { out: (t: string) => lines.push(t), err: (t: string) => errors.push(t), baseUrl };
  try {
    assert.equal(await runCli(["pipelines", "key", "PiPGM1", "green"], io), 0);
    assert.match(lines.at(-1)!, /key colour #00b140/);
    assert.equal(await runCli(["pipelines", "show", "PiPGM1"], io), 0);
    assert.equal(JSON.parse(lines.at(-1)!).keyColor, "#00b140");
    assert.equal(await runCli(["pipelines", "key", "PiPGM1", "off"], io), 0);
    assert.equal(await runCli(["pipelines", "key", "PiPGM1", "nope"], io), 1);
  } finally {
    await app.close();
  }
});
