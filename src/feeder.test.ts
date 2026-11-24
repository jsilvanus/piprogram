import assert from "node:assert/strict";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { PipgmFeeders, StillFeeder, feederArgs, ffmpegPngToRaw, rawFrameBytes, pictureKey, solidPng, type FeederProcess } from "./feeder.js";
import { EncoderSelector, createEncoderSelector } from "./encoder.js";
import { PiPgmService } from "./pipgm-service.js";
import { buildPipgmServer } from "./server.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeProc implements FeederProcess {
  writes: Buffer[] = [];
  killed = false;
  private exitListener: ((code: number | null) => void) | null = null;
  stdin = {
    write: (chunk: Buffer) => {
      this.writes.push(chunk);
      return true;
    },
    once: () => undefined,
    end: () => undefined
  };
  kill() {
    this.killed = true;
    return true;
  }
  onExit(listener: (code: number | null) => void) {
    this.exitListener = listener;
  }
  onError() {}
  crash(code = 1) {
    this.exitListener?.(code);
  }
}

function fakeSpawn() {
  const procs: FakeProc[] = [];
  const calls: string[][] = [];
  const spawn = (_command: string, args: readonly string[]) => {
    const proc = new FakeProc();
    procs.push(proc);
    calls.push([...args]);
    return proc;
  };
  return { procs, calls, spawn };
}

test("solidPng is a valid PNG of the asked size", () => {
  const png = solidPng(8, 4, [1, 2, 3]);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 8);
  assert.equal(png.readUInt32BE(20), 4);
  const idatLength = png.readUInt32BE(33);
  assert.equal(png.subarray(37, 41).toString("ascii"), "IDAT");
  const raw = inflateSync(png.subarray(41, 41 + idatLength));
  assert.equal(raw.length, (1 + 8 * 3) * 4);
  assert.deepEqual([...raw.subarray(1, 4)], [1, 2, 3]);
  assert.equal(png.subarray(-8, -4).toString("ascii"), "IEND");
});

test("feederArgs reads PNG frames from stdin and publishes over RTSP", () => {
  const args = feederArgs("rtsp://127.0.0.1:8554/PiPGM1", 5, "libx264");
  assert.ok(args.join(" ").includes("-f image2pipe -framerate 5 -c:v png -i -"));
  assert.ok(args.includes("-an"), "a feed carries no audio");
  assert.equal(args.at(-1), "rtsp://127.0.0.1:8554/PiPGM1");
  assert.ok(feederArgs("rtsp://x/y", 5, "h264_v4l2m2m").includes("h264_v4l2m2m"));
  const lowInput = feederArgs("rtsp://x/y", 5, "libx264", 1);
  assert.ok(lowInput.join(" ").includes("-f image2pipe -framerate 1 -c:v png -i -"));
  assert.ok(lowInput.join(" ").includes("-r 5 -g 5"));
});

test("StillFeeder defaults inputFps to 1 and writes a new frame immediately", () => {
  const { procs, calls, spawn } = fakeSpawn();
  const feeder = new StillFeeder({ rtspUrl: "rtsp://x/PiPGM1", fps: 5, input: "png", spawn });
  feeder.show(Buffer.from("first"), 1920, 1080);
  assert.equal(calls[0]?.[calls[0].indexOf("-framerate") + 1], "1");
  assert.equal(calls[0]?.[calls[0].indexOf("-r") + 1], "5");
  assert.equal(procs[0]?.writes.length, 1);
  feeder.show(Buffer.from("second"), 1920, 1080);
  assert.equal(procs[0]?.writes.length, 2);
  feeder.stop();
});

test("a new picture is swapped in without restarting ffmpeg", async () => {
  const { procs, spawn } = fakeSpawn();
  const feeder = new StillFeeder({ rtspUrl: "rtsp://x/PiPGM1", fps: 50, input: "png", spawn });
  const first = Buffer.from("first");
  const second = Buffer.from("second");
  feeder.show(first, 1920, 1080);
  await sleep(100);
  feeder.show(second, 1920, 1080);
  await sleep(100);
  feeder.stop();
  assert.equal(procs.length, 1, "one process for both pictures");
  const writes = procs[0]!.writes;
  assert.ok(writes.some((w) => w.equals(first)));
  assert.ok(writes.some((w) => w.equals(second)));
  assert.ok(writes.lastIndexOf(first) < writes.findLastIndex((w) => w.equals(second)), "second replaces first");
  assert.ok(procs[0]!.killed, "stop ends the process");
});

test("a different size restarts ffmpeg, the same size does not", async () => {
  const { procs, spawn } = fakeSpawn();
  const feeder = new StillFeeder({ rtspUrl: "rtsp://x/PiPGM1", fps: 50, input: "png", spawn });
  feeder.show(Buffer.from("a"), 1920, 1080);
  feeder.show(Buffer.from("b"), 1920, 1080);
  assert.equal(procs.length, 1);
  feeder.show(Buffer.from("c"), 1080, 1920);
  assert.equal(procs.length, 2);
  assert.ok(procs[0]!.killed);
  feeder.stop();
});

test("a crashed ffmpeg is started again with a growing delay", async () => {
  const { procs, spawn } = fakeSpawn();
  const errors: string[] = [];
  const feeder = new StillFeeder({
    rtspUrl: "rtsp://x/PiPGM1",
    fps: 50,
    input: "png",
    restartBaseMs: 20,
    spawn,
    onError: (message) => errors.push(message)
  });
  feeder.show(Buffer.from("a"), 100, 100);
  procs[0]!.crash(1);
  assert.equal(feeder.status().running, false);
  await sleep(60);
  assert.equal(procs.length, 2, "restarted");
  assert.equal(feeder.status().running, true);
  assert.equal(feeder.status().restarts, 1);
  assert.match(errors[0] ?? "", /exited with 1/);
  procs[1]!.crash(1);
  await sleep(25);
  assert.equal(procs.length, 2, "the second delay is longer");
  await sleep(40);
  assert.equal(procs.length, 3);
  feeder.stop();
  procs[2]!.crash(1);
  await sleep(60);
  assert.equal(procs.length, 3, "no restart after stop");
});

function setup() {
  const service = new PiPgmService();
  service.createHymnItem({ title: "Virsi", stanzas: [{ lines: ["a", "b"] }], targetPipelineId: "PiPGM1", cueImmediately: true });
  const { procs, spawn } = fakeSpawn();
  const renders: number[] = [];
  const errors: string[] = [];
  let failNext = false;
  const feeders = new PipgmFeeders({ feedInput: "png",
    service,
    rtspBase: "rtsp://127.0.0.1:8554/",
    fps: 50,
    spawn,
    renderFrame: async ({ width }) => {
      renders.push(width);
      if (failNext) {
        failNext = false;
        throw new Error("chromium failed");
      }
      return Buffer.from(`frame-${renders.length}`);
    },
    onError: (_id, message) => errors.push(message)
  });
  return { service, feeders, procs, renders, errors, failOnce: () => (failNext = true) };
}

test("each pipeline gets its own stream and renders once per change", async () => {
  const { feeders, procs, renders } = setup();
  await feeders.tick();
  assert.equal(procs.length, 3, "three feeds, one process each");
  assert.equal(renders.length, 3);
  await feeders.tick();
  assert.equal(renders.length, 3, "unchanged pictures are not rendered again");
  feeders.stop();
});

test("a change on one pipeline renders only that pipeline", async () => {
  const { service, feeders, procs, renders } = setup();
  await feeders.tick();
  service.control("PiPGM1", { action: "next" });
  await feeders.tick();
  assert.ok(renders.length === 3 || renders.length === 4);
  assert.equal(procs.length, 3, "no restart");
  feeders.stop();
});

test("fade to black publishes a black frame instead of dropping the stream", async () => {
  const { service, feeders, procs, renders } = setup();
  await feeders.tick();
  const before = renders.length;
  service.setFadeToBlack("PiPGM1", { fadeToBlack: true });
  await feeders.tick();
  assert.equal(renders.length, before, "black needs no render");
  assert.equal(procs.length, 3, "the stream stays up");
  feeders.stop();
});

test("a failed render is retried on the next pass and the feed keeps its picture", async () => {
  const { feeders, procs, renders, errors, failOnce } = setup();
  failOnce();
  await feeders.tick();
  assert.deepEqual(errors, ["chromium failed"]);
  assert.equal(procs.length, 2, "the failing pipeline has no process yet");
  await feeders.tick();
  assert.equal(procs.length, 3, "retried and published");
  assert.equal(renders.length, 4);
  feeders.stop();
});

test("pictureKey ignores volume and changes with the slide", () => {
  const service = new PiPgmService();
  service.createHymnItem({ title: "Virsi", stanzas: [{ lines: ["a"] }, { lines: ["b"] }], targetPipelineId: "PiPGM1", cueImmediately: true });
  const a = pictureKey(service.getPipeline("PiPGM1")!);
  service.setAudio("PiPGM1", { volume: 30 });
  assert.equal(pictureKey(service.getPipeline("PiPGM1")!), a);
  service.control("PiPGM1", { action: "next" });
  assert.notEqual(pictureKey(service.getPipeline("PiPGM1")!), a);
});

test("the feeders route reports whether publishing is on", async () => {
  const off = buildPipgmServer();
  assert.deepEqual((await off.inject({ url: "/api/v1/pipgm/feeders" })).json(), { enabled: false, feeds: {} });
  await off.close();

  const { spawn, procs } = fakeSpawn();
  const on = buildPipgmServer({
    publish: { rtspBase: "rtsp://127.0.0.1:8554", spawn, feedInput: "png" },
    frameRenderer: async () => Buffer.from("png")
  });
  await on.ready();
  await sleep(50);
  const body = (await on.inject({ url: "/api/v1/pipgm/feeders" })).json() as {
    enabled: boolean;
    feeds: Record<string, { running: boolean }>;
  };
  assert.equal(body.enabled, true);
  assert.deepEqual(Object.keys(body.feeds), ["PiPGM1", "PiPGM2", "PiPGM3"]);
  assert.equal(body.feeds.PiPGM1!.running, true);
  await on.close();
  assert.ok(procs.every((p) => p.killed), "closing the server stops every ffmpeg");
});

test("idle stop: an empty pipeline's ffmpeg is stopped after the idle time and restarted when a slide appears", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"] });
  const service = new PiPgmService();
  service.createHymnItem({ title: "Virsi", stanzas: [{ lines: ["a"] }], targetPipelineId: "PiPGM1", cueImmediately: true });
  const { procs, spawn } = fakeSpawn();
  const feeders = new PipgmFeeders({ feedInput: "png",
    service,
    rtspBase: "rtsp://x",
    spawn,
    idleStopSeconds: 10,
    renderFrame: async () => Buffer.from("frame")
  });
  await feeders.tick();
  assert.equal(procs.length, 3);
  assert.equal(feeders.status().PiPGM2?.state, "running");
  t.mock.timers.tick(9_000);
  await feeders.tick();
  assert.equal(feeders.status().PiPGM2?.state, "running", "not yet");
  t.mock.timers.tick(1_500);
  await feeders.tick();
  assert.equal(feeders.status().PiPGM2?.state, "idle-stopped");
  assert.equal(feeders.status().PiPGM2?.running, false);
  assert.equal(procs[1]!.killed, true, "ffmpeg of the idle feed is killed");
  assert.equal(procs[0]!.killed, false, "a pipeline with a slide keeps its feed");
  assert.equal(feeders.status().PiPGM1?.state, "running");
  await feeders.tick();
  assert.equal(procs.length, 3, "stays stopped while idle");
  // A slide appears on PiPGM2: started again at once.
  service.createHymnItem({ title: "Toinen", stanzas: [{ lines: ["b"] }], targetPipelineId: "PiPGM2", cueImmediately: true });
  await feeders.tick();
  assert.equal(procs.length, 4);
  assert.equal(feeders.status().PiPGM2?.state, "running");
  feeders.stop();
});

test("idle stop off by default: nothing is stopped", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"] });
  const { procs, spawn } = fakeSpawn();
  const feeders = new PipgmFeeders({ feedInput: "png", service: new PiPgmService(), rtspBase: "rtsp://x", spawn, renderFrame: async () => Buffer.from("f") });
  await feeders.tick();
  t.mock.timers.tick(3_600_000);
  await feeders.tick();
  assert.ok(procs.every((p) => !p.killed));
  assert.equal(feeders.status().PiPGM1?.state, "running");
  feeders.stop();
});

test("pre-warm: a loaded playlist is not idle and keeps the feed", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"] });
  const service = new PiPgmService();
  service.createHymnItem({ title: "Virsi", stanzas: [{ lines: ["a"] }], targetPipelineId: "PiPGM2" });
  const snapshot = service.getPipeline("PiPGM2")!;
  assert.ok(snapshot.playlist.length > 0);
  const { spawn } = fakeSpawn();
  const feeders = new PipgmFeeders({ feedInput: "png", service, rtspBase: "rtsp://x", spawn, idleStopSeconds: 5, renderFrame: async () => Buffer.from("f") });
  await feeders.tick();
  t.mock.timers.tick(60_000);
  await feeders.tick();
  assert.equal(feeders.status().PiPGM2?.state, "running");
  assert.equal(feeders.status().PiPGM3?.state, "idle-stopped");
  feeders.stop();
});

test("second early failure of h264_v4l2m2m restarts all feeders with libx264 and remembers it", async () => {
  const { procs, calls, spawn } = fakeSpawn();
  const warnings: string[] = [];
  const selector = new EncoderSelector({ setting: "h264_v4l2m2m" });
  const feeders = new PipgmFeeders({ feedInput: "png",
    service: new PiPgmService(),
    rtspBase: "rtsp://x",
    spawn,
    encoder: selector,
    renderFrame: async () => Buffer.from("f"),
    onFallback: (m) => warnings.push(m)
  });
  await feeders.tick();
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.includes("h264_v4l2m2m")));
  procs[0]!.crash(1); // first early failure: one retry on the hardware encoder, no fallback yet
  assert.equal(warnings.length, 0);
  assert.equal(selector.current, "h264_v4l2m2m");
  procs[1]!.crash(1); // second early failure: fall back
  assert.equal(warnings.length, 1);
  assert.equal(selector.current, "libx264");
  assert.equal(feeders.encoderInfo().fallback, true);
  assert.equal(calls.length, 3 + 3, "all three relaunched at once");
  assert.ok(calls.slice(3).every((c) => c.includes("libx264") && !c.includes("h264_v4l2m2m")));
  procs[2]!.crash(1); // the old, already replaced process: no second warning
  assert.equal(warnings.length, 1);
  feeders.stop();
});

test("a late exit of h264_v4l2m2m does not trigger the fallback; explicit fallback off never does", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"] });
  const { procs, spawn } = fakeSpawn();
  const selector = new EncoderSelector({ setting: "h264_v4l2m2m" });
  const feeder = new StillFeeder({ rtspUrl: "rtsp://x", spawn, input: "png", encoder: () => selector.current, onEarlyExit: () => selector.noteEarlyFailure() });
  feeder.show(Buffer.from("a"), 10, 10);
  t.mock.timers.tick(4_000);
  procs[0]!.crash(1);
  assert.equal(selector.current, "h264_v4l2m2m");
  feeder.stop();
  const off = new EncoderSelector({ setting: "h264_v4l2m2m", fallbackEnabled: false });
  assert.equal(off.noteEarlyFailure(), false);
  assert.equal(off.current, "h264_v4l2m2m");
  assert.equal(EncoderSelector.fixed("libx264").noteEarlyFailure(), false);
});

test("h264_v4l2m2m gets one retry: only the second early failure falls back to libx264", () => {
  const selector = new EncoderSelector({ setting: "h264_v4l2m2m" });
  assert.equal(selector.noteEarlyFailure(), false);
  assert.equal(selector.current, "h264_v4l2m2m");
  assert.equal(selector.noteEarlyFailure(), true);
  assert.equal(selector.current, "libx264");
  assert.equal(selector.fallenBack, true);
  assert.equal(selector.noteEarlyFailure(), false);
});

test("auto encoder: probe on Linux only, cached by the selector", async () => {
  const listing = " V....D h264_v4l2m2m         V4L2 mem2mem H.264 encoder wrapper\n V....D libx264 x";
  let probes = 0;
  const run = async () => {
    probes += 1;
    return listing;
  };
  assert.equal((await createEncoderSelector({ setting: "auto", platform: "linux", run })).current, "h264_v4l2m2m");
  assert.equal(probes, 1);
  assert.equal((await createEncoderSelector({ setting: "auto", platform: "darwin", run })).current, "libx264");
  assert.equal((await createEncoderSelector({ setting: "auto", platform: "win32", run })).current, "libx264");
  assert.equal(probes, 1, "no probe off Linux");
  assert.equal((await createEncoderSelector({ setting: "auto", platform: "linux", run: async () => " V....D libx264 x" })).current, "libx264");
  assert.equal((await createEncoderSelector({ setting: "auto", platform: "linux", run: async () => { throw new Error("no ffmpeg"); } })).current, "libx264");
  assert.equal((await createEncoderSelector({ setting: "libx264", platform: "linux", run })).current, "libx264");
  assert.equal(probes, 1, "explicit setting needs no probe");
  assert.equal((await createEncoderSelector({ setting: "h264_v4l2m2m", platform: "darwin", run })).current, "h264_v4l2m2m");
});

test("feederArgs raw mode reads raw yuv420p at the even size and has no PNG decoder", () => {
  const args = feederArgs("rtsp://x/y", 5, "libx264", 1, { width: 1921, height: 1081 }).join(" ");
  assert.ok(args.includes("-f rawvideo -pix_fmt yuv420p -s 1920x1080 -framerate 1 -i -"));
  assert.ok(!args.includes("image2pipe") && !args.includes("-c:v png"));
  assert.ok(args.includes("-r 5 -g 5"));
  assert.equal(rawFrameBytes(1921, 1081), 1920 * 1080 * 1.5);
});

test("raw mode: the picture is converted once per change and the raw frame is what is written each tick", async () => {
  const { procs, calls, spawn } = fakeSpawn();
  const converted: Buffer[] = [];
  const convert = async (png: Buffer) => {
    converted.push(png);
    return Buffer.from(`raw-of-${png.toString()}`);
  };
  const feeder = new StillFeeder({ rtspUrl: "rtsp://x/PiPGM1", fps: 50, inputFps: 50, input: "raw", convert, spawn });
  feeder.show(Buffer.from("a"), 1920, 1080);
  await sleep(100);
  assert.equal(converted.length, 1, "decoded once, not per tick");
  assert.ok(calls[0]!.join(" ").includes("-f rawvideo -pix_fmt yuv420p -s 1920x1080"));
  assert.ok(procs[0]!.writes.length > 1);
  assert.ok(procs[0]!.writes.every((w) => w.toString() === "raw-of-a"));
  feeder.show(Buffer.from("b"), 1920, 1080);
  await sleep(100);
  assert.equal(procs.length, 1, "same size and format: no restart");
  assert.equal(procs[0]!.writes.at(-1)!.toString(), "raw-of-b");
  feeder.show(Buffer.from("c"), 1080, 1920);
  await sleep(50);
  assert.equal(procs.length, 2, "a size change restarts");
  assert.ok(calls[1]!.join(" ").includes("-s 1080x1920"));
  feeder.stop();
});

test("raw mode: a failed conversion feeds the PNG for that picture with a warning, then raw resumes", async () => {
  const { procs, calls, spawn } = fakeSpawn();
  const errors: string[] = [];
  let fail = false;
  const convert = async (png: Buffer) => {
    if (fail) throw new Error("boom");
    return Buffer.from(`raw-of-${png.toString()}`);
  };
  const feeder = new StillFeeder({ rtspUrl: "rtsp://x/PiPGM1", fps: 50, inputFps: 50, input: "raw", convert, spawn, onError: (m) => errors.push(m) });
  feeder.show(Buffer.from("a"), 100, 100);
  await sleep(30);
  fail = true;
  feeder.show(Buffer.from("b"), 100, 100);
  await sleep(60);
  assert.match(errors[0] ?? "", /raw conversion failed.*boom/);
  assert.equal(procs.length, 2, "input type changed, so one restart");
  assert.ok(calls[1]!.join(" ").includes("image2pipe"));
  assert.ok(procs[1]!.writes.some((w) => w.toString() === "b"));
  fail = false;
  feeder.show(Buffer.from("c"), 100, 100);
  await sleep(60);
  assert.equal(procs.length, 3);
  assert.ok(calls[2]!.join(" ").includes("rawvideo"));
  feeder.stop();
});

test("raw mode: a conversion that finishes after a newer picture is dropped", async () => {
  const { procs, spawn } = fakeSpawn();
  const releases: Array<() => void> = [];
  const convert = (png: Buffer) => new Promise<Buffer>((resolve) => releases.push(() => resolve(Buffer.from(`raw-${png.toString()}`))));
  const feeder = new StillFeeder({ rtspUrl: "rtsp://x/PiPGM1", fps: 50, inputFps: 50, input: "raw", convert, spawn });
  feeder.show(Buffer.from("old"), 100, 100);
  feeder.show(Buffer.from("new"), 100, 100);
  releases[1]!();
  await sleep(30);
  releases[0]!();
  await sleep(30);
  assert.ok(procs[0]!.writes.every((w) => w.toString() === "raw-new"));
  feeder.stop();
});

test("ffmpegPngToRaw converts a real PNG to one even-sized yuv420p frame", async (t) => {
  const raw = await ffmpegPngToRaw()(solidPng(5, 3, [255, 0, 0]), 5, 3).catch((e: Error) => e);
  if (raw instanceof Error) return t.skip(`ffmpeg unavailable: ${raw.message}`);
  assert.equal(raw.length, rawFrameBytes(5, 3));
  assert.equal(raw.length, 4 * 2 * 1.5);
});
