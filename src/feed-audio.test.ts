import assert from "node:assert/strict";
import test from "node:test";
import { AUDIO_FRAME_BYTES, AUDIO_RATE, FeedAudio, ffmpegAudioToPcm } from "./feed-audio.js";
import { feederArgs } from "./feeder.js";

/** Constant-level stereo PCM of the given length. */
function constant(frames: number, level = 10_000): Buffer {
  const b = Buffer.alloc(frames * AUDIO_FRAME_BYTES);
  for (let i = 0; i < frames * 2; i += 1) b.writeInt16LE(level, i * 2);
  return b;
}
const sample = (b: Buffer, frame: number) => b.readInt16LE(frame * AUDIO_FRAME_BYTES);

test("silence when nothing plays", () => {
  const out = new FeedAudio().pull(100);
  assert.equal(out.length, 100 * AUDIO_FRAME_BYTES);
  assert.ok(out.every((byte) => byte === 0));
});

test("a track fades in and plays at the set volume", () => {
  const audio = new FeedAudio({ fadeInMs: 1000 });
  audio.setVolume(0.5);
  audio.play(constant(AUDIO_RATE * 3), { key: "p1", loop: false });
  assert.equal(audio.playKey, "p1");
  const out = audio.pull(AUDIO_RATE * 2);
  assert.equal(sample(out, 0), 0);
  assert.ok(Math.abs(sample(out, AUDIO_RATE / 2) - 2500) < 5); // half way through the fade: 0.5 * 0.5 * 10000
  assert.equal(sample(out, AUDIO_RATE * 2 - 1), 5000);
});

test("a non-looping track ends in silence; a looping one repeats", () => {
  const once = new FeedAudio({ fadeInMs: 0 });
  once.setVolume(1);
  once.play(constant(10), { key: "a", loop: false });
  const out = once.pull(20);
  assert.equal(sample(out, 9), 10_000);
  assert.equal(sample(out, 10), 0);
  assert.equal(once.playing, false);

  const loop = new FeedAudio({ fadeInMs: 0 });
  loop.setVolume(1);
  loop.play(constant(10), { key: "b", loop: true });
  const looped = loop.pull(35);
  assert.equal(sample(looped, 34), 10_000);
  assert.equal(loop.playing, true);
});

test("stop fades out and then drops the track", () => {
  const audio = new FeedAudio({ fadeInMs: 0, fadeOutMs: 10 });
  audio.setVolume(1);
  audio.play(constant(AUDIO_RATE), { key: "x", loop: true });
  audio.pull(100);
  audio.stop();
  assert.equal(audio.playKey, null);
  const out = audio.pull(AUDIO_RATE / 10);
  assert.ok(sample(out, 0) > sample(out, 400));
  assert.equal(sample(out, 600), 0);
  assert.equal(audio.playing, false);
});

test("volume 0 mutes and gain is clamped", () => {
  const audio = new FeedAudio({ fadeInMs: 0 });
  audio.setVolume(0);
  audio.play(constant(10), { key: "m", loop: true });
  assert.equal(sample(audio.pull(5), 2), 0);
  audio.setVolume(5);
  assert.equal(sample(audio.pull(5), 2), 10_000);
});

test("feederArgs adds an AAC track on fd 3 only when audio is on", () => {
  const without = feederArgs("rtsp://x/PiPGM1", 5, "libx264", 1, { width: 640, height: 360 });
  assert.ok(without.includes("-an"));
  assert.ok(!without.includes("pipe:3"));
  const withAudio = feederArgs("rtsp://x/PiPGM1", 5, "libx264", 1, { width: 640, height: 360 }, true);
  assert.ok(!withAudio.includes("-an"));
  const i = withAudio.indexOf("pipe:3");
  assert.ok(i > 0);
  assert.equal(withAudio[i - 1], "-i");
  assert.deepEqual(withAudio.slice(withAudio.indexOf("-map"), withAudio.indexOf("-map") + 4), ["-map", "0:v", "-map", "1:a"]);
  assert.ok(withAudio.includes("aac"));
  assert.equal(withAudio.at(-1), "rtsp://x/PiPGM1");
  const png = feederArgs("rtsp://x/PiPGM1", 5, "libx264", 1, undefined, true);
  assert.ok(!png.includes("-an") && png.includes("pipe:3"));
});

test("ffmpegAudioToPcm decodes a WAV to 48 kHz stereo (real ffmpeg)", async () => {
  // 0.1 s of 22.05 kHz mono silence as a WAV.
  const data = Buffer.alloc(2205 * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(22_050, 24);
  header.writeUInt32LE(44_100, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  const pcm = await ffmpegAudioToPcm()(Buffer.concat([header, data]));
  assert.ok(Math.abs(pcm.length / AUDIO_FRAME_BYTES - 4800) < 50);
  await assert.rejects(ffmpegAudioToPcm()(Buffer.from("not audio")));
  await assert.rejects(ffmpegAudioToPcm("ffmpeg", 0.01)(Buffer.concat([header, data])), /longer than/);
});

// ---- through PipgmFeeders (fake ffmpeg, fake decoder) ----
import { PipgmFeeders, type FeederProcess } from "./feeder.js";
import { PiPgmService } from "./pipgm-service.js";

class Proc implements FeederProcess {
  video: Buffer[] = [];
  pcm: Buffer[] = [];
  stdin = { write: (c: Buffer) => (this.video.push(c), true), once: () => undefined, end: () => undefined };
  audioIn = { write: (c: Buffer) => (this.pcm.push(c), true), once: () => undefined, end: () => undefined };
  kill() { return true; }
  onExit() {}
  onError() {}
  get loud(): boolean {
    return this.pcm.some((c) => c.some((b) => b !== 0));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a prepared phrase played on an armed feed reaches ffmpeg's audio pipe; stop and kill go silent", async () => {
  const service = new PiPgmService({
    ttsEngine: {
      async synthesize() {
        const data = Buffer.alloc(4410);
        const h = Buffer.alloc(44);
        h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVEfmt ", 8);
        h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
        h.writeUInt32LE(22_050, 24); h.writeUInt32LE(44_100, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
        h.write("data", 36); h.writeUInt32LE(data.length, 40);
        return Buffer.concat([h, data]);
      }
    }
  });
  const procs: Proc[] = [];
  const argsSeen: string[][] = [];
  const feeders = new PipgmFeeders({
    feedInput: "png",
    service,
    rtspBase: "rtsp://x",
    spawn: (_c, args) => {
      argsSeen.push([...args]);
      const p = new Proc();
      procs.push(p);
      return p;
    },
    renderFrame: async () => Buffer.from("f"),
    audio: {
      load: (id) => service.readAudioItemBytes(id),
      // Stand-in decoder: loud constant PCM, 1 s.
      toPcm: async () => constant(AUDIO_RATE, 12_000)
    }
  });
  service.createHymnItem({ title: "Virsi", stanzas: [{ lines: ["a"] }], targetPipelineId: "PiPGM1", cueImmediately: true });
  await feeders.tick();
  assert.ok(argsSeen.every((a) => a.includes("pipe:3")), "every feed has an audio input");
  await sleep(350);
  assert.equal(procs[0]!.loud, false, "silence before anything plays");
  assert.ok(procs[0]!.pcm.length > 0, "silence is still written");

  const prepared = await service.prepareSpeech({ text: "Tervetuloa" });
  assert.ok(prepared.ok);
  service.setAudio("PiPGM1", { audioEnabled: true, volume: 100 });
  assert.equal(service.playAudio("PiPGM1", { itemId: prepared.item.id, loop: true }).ok, true);
  await feeders.tick();
  await sleep(2200); // 1.5 s fade-in, then full level
  assert.equal(procs[0]!.loud, true, "the phrase is in the audio pipe");
  assert.equal(procs[1]!.loud, false, "other feeds stay silent");

  service.killAudio();
  await feeders.tick();
  await sleep(300);
  const before = procs[0]!.pcm.length;
  procs[0]!.pcm.length = 0;
  await sleep(300);
  assert.ok(procs[0]!.pcm.length > 0 && !procs[0]!.loud, "silence again after the kill switch");
  assert.ok(before > 0);
  feeders.stop();
});
