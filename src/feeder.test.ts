import assert from "node:assert/strict";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { PipgmFeeders, StillFeeder, feederArgs, pictureKey, solidPng, type FeederProcess } from "./feeder.js";
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
});

test("a new picture is swapped in without restarting ffmpeg", async () => {
  const { procs, spawn } = fakeSpawn();
  const feeder = new StillFeeder({ rtspUrl: "rtsp://x/PiPGM1", fps: 50, spawn });
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
  const feeder = new StillFeeder({ rtspUrl: "rtsp://x/PiPGM1", fps: 50, spawn });
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
  const feeders = new PipgmFeeders({
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
    publish: { rtspBase: "rtsp://127.0.0.1:8554", spawn },
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
