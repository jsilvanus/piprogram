import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_AUDIO_LEVELS, parseAudioLevels } from "./audio-levels.js";
import { PiPgmService } from "./pipgm-service.js";
import { buildPipgmServer } from "./server.js";

test("levels: defaults, overrides by name, and validation", () => {
  assert.deepEqual(parseAudioLevels(undefined), DEFAULT_AUDIO_LEVELS);
  assert.deepEqual(parseAudioLevels("whisper=5, normal=20,loud=40,shout=70"), { whisper: 5, normal: 20, loud: 40, shout: 70 });
  assert.equal(parseAudioLevels("normal=30").normal, 30, "unlisted names keep their default");
  assert.throws(() => parseAudioLevels("quiet=5"), /unknown level/);
  assert.throws(() => parseAudioLevels("loud=101"), /0 to 100/);
  assert.throws(() => parseAudioLevels("loud=abc"), /0 to 100/);
  assert.throws(() => parseAudioLevels("normal=50"), /must rise/);
  assert.throws(() => parseAudioLevels("whisper=30"), /must rise/);
});

test("HTTP: a level sets the volume behind its name, still capped; volume+level and unknown levels are refused", async () => {
  const service = new PiPgmService({ audioLevels: { whisper: 5, normal: 20, loud: 40, shout: 90 }, audioMaxVolume: 60 });
  const app = buildPipgmServer({ service });
  try {
    const levels = await app.inject({ method: "GET", url: "/api/v1/pipgm/audio/levels" });
    assert.equal(levels.statusCode, 200);
    assert.deepEqual(levels.json(), { levels: { whisper: 5, normal: 20, loud: 40, shout: 90 }, maxVolume: 60 });

    const loud = await app.inject({ method: "POST", url: "/api/v1/pipgm/pipelines/PiPGM1/audio", payload: { audioEnabled: true, level: "loud" } });
    assert.equal(loud.statusCode, 200);
    assert.equal(loud.json().volume, 40);
    assert.equal(loud.json().effectiveVolume, 40);

    const shout = await app.inject({ method: "POST", url: "/api/v1/pipgm/pipelines/PiPGM1/audio", payload: { level: "shout" } });
    assert.equal(shout.json().volume, 90);
    assert.equal(shout.json().effectiveVolume, 60, "the gain cap still wins");

    const both = await app.inject({ method: "POST", url: "/api/v1/pipgm/pipelines/PiPGM1/audio", payload: { level: "loud", volume: 10 } });
    assert.equal(both.statusCode, 422);
    assert.equal(both.json().error.code, "VOLUME_AND_LEVEL");
    const unknown = await app.inject({ method: "POST", url: "/api/v1/pipgm/pipelines/PiPGM1/audio", payload: { level: "medium" } });
    assert.equal(unknown.statusCode, 422);
    assert.equal(unknown.json().error.code, "INVALID_LEVEL");

    const sound = service.createUploadedMediaItem({ kind: "audio", filename: "k.mp3", dataBase64: Buffer.from("x").toString("base64") });
    const played = await app.inject({ method: "POST", url: "/api/v1/pipgm/pipelines/PiPGM1/audio/play", payload: { itemId: sound.id, level: "whisper" } });
    assert.equal(played.statusCode, 200);
    assert.equal(played.json().volume, 5);
  } finally {
    await app.close();
  }
});
