import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublishController, type RunningFeeders } from "./publish-controller.js";
import { ALSA_DEVICE, LocalAudio, SoundOutputState, applyGain, parseLocalAudioDevices, type LocalPlayerProcess } from "./local-audio.js";
import { PiPgmService } from "./pipgm-service.js";
import { buildPipgmServer } from "./server.js";
import { AUDIO_FRAME_BYTES } from "./feed-audio.js";

function fakeFeeders(log: string[], tag: string): RunningFeeders {
  return { start: () => void log.push(`start ${tag}`), stop: () => void log.push(`stop ${tag}`), status: () => ({}), encoderInfo: () => ({}) };
}

test("publishing is off by default, switched at runtime, validated and remembered", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pipgm-pub-"));
  try {
    const log: string[] = [];
    const make = (defaults?: { rtspBase?: string; audio?: boolean }) =>
      new PublishController({ cacheDir: dir, defaults, create: async (c) => fakeFeeders(log, `${c.rtspBase}|${c.audio}`) });
    const first = make();
    await first.start();
    assert.deepEqual(first.snapshot(), { enabled: false, rtspBase: null, audio: false, source: "default", running: false });
    assert.equal((await first.apply({ enabled: true })).ok, false, "needs an address");
    assert.equal((await first.apply({ rtspBase: "http://x" })).ok, false);
    assert.equal((await first.apply({ enabled: "yes" })).ok, false);
    assert.equal((await first.apply({ enabled: true, rtspBase: "rtsp://127.0.0.1:8554/" })).ok, true);
    assert.deepEqual(log, ["start rtsp://127.0.0.1:8554|false"]);
    await first.apply({ audio: true });
    assert.deepEqual(log.slice(1), ["stop rtsp://127.0.0.1:8554|false", "start rtsp://127.0.0.1:8554|true"], "a change restarts the feeds");
    await first.apply({ audio: true });
    assert.equal(log.length, 3, "no change, no restart");
    await first.stop();
    assert.match(await readFile(join(dir, "publish-settings.json"), "utf8"), /"enabled": true/);

    // After a restart the stored setting wins over the env seed; "off" is remembered too.
    log.length = 0;
    const second = make({ rtspBase: "rtsp://other:1", audio: false });
    await second.start();
    assert.equal(second.snapshot().source, "stored");
    assert.deepEqual(log, ["start rtsp://127.0.0.1:8554|true"]);
    await second.apply({ enabled: false });
    assert.equal(second.snapshot().running, false);
    const third = make({ rtspBase: "rtsp://other:1" });
    await third.start();
    assert.equal(third.snapshot().enabled, false, "stored off beats the env seed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("without a stored setting the env seed starts publishing (old behaviour)", async () => {
  const log: string[] = [];
  const c = new PublishController({ defaults: { rtspBase: "rtsp://127.0.0.1:8554", audio: true }, create: async (x) => fakeFeeders(log, `${x.rtspBase}|${x.audio}`) });
  await c.start();
  assert.equal(c.snapshot().source, "env");
  assert.deepEqual(log, ["start rtsp://127.0.0.1:8554|true"]);
});

test("local audio devices parse and validate; gain is applied with edges faded", () => {
  assert.deepEqual(parseLocalAudioDevices("hdmi0=hdmi:CARD=vc4hdmi0,hdmi1=hdmi:CARD=vc4hdmi1"), { hdmi0: "hdmi:CARD=vc4hdmi0", hdmi1: "hdmi:CARD=vc4hdmi1" });
  assert.deepEqual(parseLocalAudioDevices(undefined), {});
  assert.throws(() => parseLocalAudioDevices("hdmi2=x"), /unknown output/);
  assert.throws(() => parseLocalAudioDevices("hdmi0=bad;rm"), /ALSA/);
  assert.equal(ALSA_DEVICE.test("hdmi:CARD=vc4hdmi0"), true);
  const pcm = Buffer.alloc(4800 * AUDIO_FRAME_BYTES);
  for (let i = 0; i < 4800 * 2; i += 1) pcm.writeInt16LE(10_000, i * 2);
  const out = applyGain(pcm, 0.5);
  assert.equal(out.readInt16LE(2400 * AUDIO_FRAME_BYTES), 5000);
  assert.ok(out.readInt16LE(0) < 100, "starts faded");
  assert.ok(out.readInt16LE(out.length - 4) < 100, "ends faded");
});

test("the sound output report goes stale", () => {
  let now = 1_000;
  const state = new SoundOutputState(30_000, () => now);
  assert.equal(state.current(), null);
  state.set("hdmi1", "pigateway");
  assert.equal(state.current(), "hdmi1");
  now += 31_000;
  assert.equal(state.current(), null, "a silent gateway must not leave us playing into an old route");
  assert.equal(state.snapshot().reported, "hdmi1");
  assert.equal(state.snapshot().stale, true);
});

function wavItem(service: PiPgmService) {
  return service.createUploadedMediaItem({ kind: "audio", filename: "k.mp3", dataBase64: Buffer.from("x").toString("base64") });
}

test("HTTP: publish and local-audio are runtime config; speak goes to the reported output, is capped, dry-runs and is killed", async () => {
  const spawned: Array<{ args: readonly string[]; written: Buffer[]; killed: boolean }> = [];
  const service = new PiPgmService({ audioLevels: { whisper: 5, normal: 20, loud: 40, shout: 90 }, audioMaxVolume: 60 });
  const app = buildPipgmServer({
    service,
    localAudio: {
      toPcm: async () => Buffer.alloc(480 * AUDIO_FRAME_BYTES),
      spawn: (_command, args) => {
        const entry = { args, written: [] as Buffer[], killed: false };
        spawned.push(entry);
        const proc: LocalPlayerProcess = {
          stdin: { write: (c: Buffer) => entry.written.push(c), end: () => undefined },
          kill: () => ((entry.killed = true), true),
          onExit: () => undefined,
          onError: () => undefined
        };
        return proc;
      }
    }
  });
  try {
    const item = wavItem(service);
    const off = await app.inject({ method: "GET", url: "/api/v1/pipgm/publish" });
    assert.equal(off.json().enabled, false);
    const bad = await app.inject({ method: "PUT", url: "/api/v1/pipgm/publish", payload: { enabled: true } });
    assert.equal(bad.statusCode, 422);
    assert.equal(bad.json().error.code, "RTSP_BASE_REQUIRED");

    // Nothing is configured or reported yet.
    let speak = await app.inject({ method: "POST", url: "/api/v1/pipgm/audio/speak", payload: { itemId: item.id } });
    assert.equal(speak.statusCode, 409);
    assert.equal(speak.json().error.code, "SOUND_OUTPUT_UNKNOWN");

    assert.equal((await app.inject({ method: "PUT", url: "/api/v1/pipgm/audio/sound-output", payload: { output: "hdmi5" } })).statusCode, 422);
    const reported = await app.inject({ method: "PUT", url: "/api/v1/pipgm/audio/sound-output", payload: { output: "hdmi0", source: "pigateway" } });
    assert.equal(reported.json().output, "hdmi0");

    speak = await app.inject({ method: "POST", url: "/api/v1/pipgm/audio/speak", payload: { itemId: item.id } });
    assert.equal(speak.json().error.code, "LOCAL_AUDIO_NOT_CONFIGURED", "off until switched on");

    const bad2 = await app.inject({ method: "PUT", url: "/api/v1/pipgm/local-audio", payload: { devices: { hdmi0: "no good;" } } });
    assert.equal(bad2.statusCode, 422);
    const on = await app.inject({ method: "PUT", url: "/api/v1/pipgm/local-audio", payload: { enabled: true, devices: { hdmi0: "hdmi:CARD=vc4hdmi0", hdmi1: "hdmi:CARD=vc4hdmi1" } } });
    assert.equal(on.json().configured, true);

    const dry = await app.inject({ method: "POST", url: "/api/v1/pipgm/audio/speak", payload: { itemId: item.id, level: "shout", dryRun: true } });
    assert.equal(dry.statusCode, 200);
    assert.deepEqual({ played: dry.json().played, output: dry.json().output, device: dry.json().device, volume: dry.json().volume }, { played: false, output: "hdmi0", device: "hdmi:CARD=vc4hdmi0", volume: 60 });
    assert.equal(spawned.length, 0, "a dry run plays nothing");

    // The route moves to hdmi1: the next phrase follows it, with no config change.
    await app.inject({ method: "PUT", url: "/api/v1/pipgm/audio/sound-output", payload: { output: "hdmi1" } });
    const played = await app.inject({ method: "POST", url: "/api/v1/pipgm/audio/speak", payload: { itemId: item.id, level: "whisper" } });
    assert.equal(played.statusCode, 200);
    assert.equal(played.json().played, true);
    assert.equal(played.json().volume, 5);
    assert.equal(spawned.length, 1);
    assert.ok(spawned[0]!.args.includes("hdmi:CARD=vc4hdmi1"));
    assert.equal(spawned[0]!.written.length, 1);

    assert.equal((await app.inject({ method: "POST", url: "/api/v1/pipgm/audio/speak", payload: { itemId: item.id, level: "loud", volume: 10 } })).statusCode, 422);
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/pipgm/audio/speak", payload: { itemId: "nope" } })).statusCode, 404);

    await app.inject({ method: "POST", url: "/api/v1/pipgm/audio/kill" });
    assert.equal(spawned[0]!.killed, true, "the kill switch stops the phrase");

    await app.inject({ method: "PUT", url: "/api/v1/pipgm/local-audio", payload: { enabled: false } });
    const after = await app.inject({ method: "POST", url: "/api/v1/pipgm/audio/speak", payload: { itemId: item.id } });
    assert.equal(after.json().error.code, "LOCAL_AUDIO_NOT_CONFIGURED");
  } finally {
    await app.close();
  }
});
