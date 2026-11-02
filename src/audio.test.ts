import assert from "node:assert/strict";
import test from "node:test";
import { PiPgmService } from "./pipgm-service.js";
import { buildPipgmServer } from "./server.js";
import { renderPiPgmStageHtml } from "./stage-html.js";

const MP3 = Buffer.from("fake-mp3").toString("base64");
const PNG = Buffer.from("fake-png").toString("base64");

function makeService(extra: { audioMaxVolume?: number; audioArmSeconds?: number } = {}) {
  const clock = { t: 1_000_000 };
  const service = new PiPgmService({ now: () => clock.t, ...extra });
  const sound = service.createUploadedMediaItem({ kind: "audio", filename: "kello.mp3", dataBase64: MP3 });
  return { service, clock, sound };
}

test("sound is disarmed by default and playing is refused until it is armed", () => {
  const { service, sound } = makeService();
  const snapshot = service.getPipeline("PiPGM2")!;
  assert.equal(snapshot.audioEnabled, false);
  assert.equal(snapshot.audioArmedUntil, null);
  assert.deepEqual(service.playAudio("PiPGM2", { itemId: sound.id }), { ok: false, code: "AUDIO_NOT_ARMED" });
});

test("armed sound plays as audio content, separate from the visual", () => {
  const { service, sound } = makeService();
  const hymn = service.createHymnItem({ title: "Virsi", stanzas: [{ lines: ["a"] }], targetPipelineId: "PiPGM2", cueImmediately: true });
  service.setAudio("PiPGM2", { audioEnabled: true });
  const result = service.playAudio("PiPGM2", { itemId: sound.id });
  assert.equal(result.ok, true);
  const pipeline = service.getPipeline("PiPGM2")!;
  assert.equal(pipeline.audioTrack?.itemId, sound.id);
  assert.equal(pipeline.activeItemId, hymn.id, "the visual is untouched");
  assert.equal(service.getPipeline("PiPGM1")!.audioTrack, null, "other feeds are untouched");
});

test("playing something that is not an audio item, or does not exist, is refused", () => {
  const { service } = makeService();
  const image = service.createUploadedMediaItem({ kind: "image", filename: "a.png", dataBase64: PNG });
  service.setAudio("PiPGM1", { audioEnabled: true });
  assert.deepEqual(service.playAudio("PiPGM1", { itemId: image.id }), { ok: false, code: "ITEM_NOT_AUDIO" });
  assert.deepEqual(service.playAudio("PiPGM1", { itemId: "nope" }), { ok: false, code: "ITEM_NOT_FOUND" });
});

test("the gain cap limits the effective volume whatever is requested", () => {
  const { service } = makeService({ audioMaxVolume: 40 });
  service.setAudio("PiPGM1", { audioEnabled: true, volume: 100 });
  const pipeline = service.getPipeline("PiPGM1")!;
  assert.equal(pipeline.volume, 100);
  assert.equal(pipeline.maxVolume, 40);
  assert.equal(pipeline.effectiveVolume, 40);
  service.setAudio("PiPGM1", { volume: 25 });
  assert.equal(service.getPipeline("PiPGM1")!.effectiveVolume, 25);
});

test("arming ends by itself: the track stops and sound is disarmed", () => {
  const { service, clock, sound } = makeService({ audioArmSeconds: 60 });
  service.setAudio("PiPGM1", { audioEnabled: true });
  service.playAudio("PiPGM1", { itemId: sound.id });
  const armed = service.getPipeline("PiPGM1")!;
  assert.equal(armed.audioArmedUntil, new Date(1_000_000 + 60_000).toISOString());
  clock.t += 59_000;
  assert.equal(service.getPipeline("PiPGM1")!.audioEnabled, true);
  clock.t += 2_000;
  const expired = service.getPipeline("PiPGM1")!;
  assert.equal(expired.audioEnabled, false);
  assert.equal(expired.audioTrack, null);
  assert.deepEqual(service.playAudio("PiPGM1", { itemId: sound.id }), { ok: false, code: "AUDIO_NOT_ARMED" });
});

test("disarming stops the track; stop keeps the feed armed", () => {
  const { service, sound } = makeService();
  service.setAudio("PiPGM1", { audioEnabled: true });
  service.playAudio("PiPGM1", { itemId: sound.id });
  assert.equal(service.stopAudio("PiPGM1")!.audioTrack, null);
  assert.equal(service.getPipeline("PiPGM1")!.audioEnabled, true);
  service.playAudio("PiPGM1", { itemId: sound.id });
  service.setAudio("PiPGM1", { audioEnabled: false });
  const off = service.getPipeline("PiPGM1")!;
  assert.equal(off.audioTrack, null);
  assert.equal(off.audioArmedUntil, null);
});

test("the kill switch silences and disarms every pipeline", () => {
  const { service, sound } = makeService();
  for (const id of ["PiPGM1", "PiPGM2", "PiPGM3"] as const) {
    service.setAudio(id, { audioEnabled: true });
    service.playAudio(id, { itemId: sound.id });
  }
  const killed = service.killAudio();
  assert.equal(killed.length, 3);
  for (const pipeline of killed) {
    assert.equal(pipeline.audioEnabled, false);
    assert.equal(pipeline.audioTrack, null);
    assert.equal(pipeline.audioArmedUntil, null);
  }
});

test("the basic image is optional, must be an image item, and can be cleared", () => {
  const { service, sound } = makeService();
  const image = service.createUploadedMediaItem({ kind: "image", filename: "lasi.png", dataBase64: PNG });
  assert.equal(service.getPipeline("PiPGM1")!.basicImageUrl, null, "black by default");
  assert.equal(service.setBasicImage("PiPGM1", sound.id), "ITEM_NOT_IMAGE");
  assert.equal(service.setBasicImage("PiPGM1", "nope"), "ITEM_NOT_FOUND");
  const set = service.setBasicImage("PiPGM1", image.id);
  assert.notEqual(typeof set, "string");
  assert.equal(service.getPipeline("PiPGM1")!.basicImageUrl, image.image!.assetUrl);
  service.setBasicImage("PiPGM1", null);
  assert.equal(service.getPipeline("PiPGM1")!.basicImageItemId, null);
});

test("the stage page carries the audio track and can be rendered silent", () => {
  const { service, sound } = makeService();
  service.setAudio("PiPGM1", { audioEnabled: true });
  service.playAudio("PiPGM1", { itemId: sound.id });
  const pipeline = service.getPipeline("PiPGM1")!;
  assert.match(renderPiPgmStageHtml(pipeline), /const SILENT = false/);
  assert.match(renderPiPgmStageHtml(pipeline, { silent: true }), /const SILENT = true/);
  assert.ok(renderPiPgmStageHtml(pipeline).includes(pipeline.audioTrack!.playId));
});

test("HTTP: play needs arming (409), the kill route disarms, and writes need the API key", async () => {
  const app = buildPipgmServer({ apiKey: "k" });
  const auth = { authorization: "Bearer k" };
  try {
    const media = await app.inject({
      method: "POST",
      url: "/api/v1/pipgm/items/media",
      headers: auth,
      payload: { kind: "audio", filename: "kello.mp3", dataBase64: MP3 }
    });
    assert.equal(media.statusCode, 201);
    assert.equal(media.json().kind, "audio");
    const itemId = media.json().id as string;

    const refused = await app.inject({
      method: "POST",
      url: "/api/v1/pipgm/pipelines/PiPGM2/audio/play",
      headers: auth,
      payload: { itemId }
    });
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().error.code, "AUDIO_NOT_ARMED");

    const arm = await app.inject({
      method: "POST",
      url: "/api/v1/pipgm/pipelines/PiPGM2/audio",
      headers: auth,
      payload: { audioEnabled: true, armSeconds: 120, volume: 90 }
    });
    assert.equal(arm.statusCode, 200);
    assert.ok(arm.json().audioArmedUntil);
    assert.ok(arm.json().effectiveVolume <= arm.json().maxVolume);

    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/pipgm/pipelines/PiPGM2/audio",
      headers: auth,
      payload: { armSeconds: 99999 }
    });
    assert.equal(bad.statusCode, 422);

    const played = await app.inject({
      method: "POST",
      url: "/api/v1/pipgm/pipelines/PiPGM2/audio/play",
      headers: auth,
      payload: { itemId }
    });
    assert.equal(played.statusCode, 200);
    assert.equal(played.json().audioTrack.itemId, itemId);

    const noKey = await app.inject({ method: "POST", url: "/api/v1/pipgm/audio/kill" });
    assert.equal(noKey.statusCode, 401);
    const kill = await app.inject({ method: "POST", url: "/api/v1/pipgm/audio/kill", headers: auth });
    assert.equal(kill.statusCode, 200);
    const after = await app.inject({ method: "GET", url: "/api/v1/pipgm/pipelines/PiPGM2" });
    assert.equal(after.json().audioEnabled, false);
    assert.equal(after.json().audioTrack, null);
  } finally {
    await app.close();
  }
});

test("HTTP: basic image route validates the item", async () => {
  const app = buildPipgmServer();
  try {
    const image = await app.inject({
      method: "POST",
      url: "/api/v1/pipgm/items/media",
      payload: { kind: "image", filename: "lasi.png", dataBase64: PNG }
    });
    const imageId = image.json().id as string;
    const ok = await app.inject({ method: "PUT", url: "/api/v1/pipgm/pipelines/PiPGM1/basic-image", payload: { itemId: imageId } });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().basicImageItemId, imageId);
    const missing = await app.inject({ method: "PUT", url: "/api/v1/pipgm/pipelines/PiPGM1/basic-image", payload: { itemId: "nope" } });
    assert.equal(missing.statusCode, 404);
    const cleared = await app.inject({ method: "PUT", url: "/api/v1/pipgm/pipelines/PiPGM1/basic-image", payload: { itemId: null } });
    assert.equal(cleared.json().basicImageItemId, null);
  } finally {
    await app.close();
  }
});
