import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { chromiumLaunchArgs, createChromiumFrameRenderer, FrameRendererUnavailableError, isPng } from "./frame.js";
import { buildPipgmServer } from "./server.js";
import { aspectRatioLabel, buildSlideFeed } from "./pipgm-model.js";

// 1x1 transparent PNG
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

interface FakeCommand {
  method: string;
  params: any;
  sessionId?: string;
}

/** A fake Chromium process plus a fake DevTools socket, driven in memory. */
function fakeBrowserHarness(options: { screenshotGate?: boolean } = {}) {
  const spawns: Array<{ binary: string; args: string[]; child: FakeChild }> = [];
  const commands: FakeCommand[] = [];
  const sockets: FakeSocket[] = [];
  const gates: Array<() => void> = [];
  let active = 0;
  let maxActive = 0;
  let targetCounter = 0;

  class FakeChild extends EventEmitter {
    stderr = new EventEmitter();
    killed = false;
    kill(): boolean {
      if (!this.killed) {
        this.killed = true;
        setImmediate(() => this.emit("exit", null, "SIGKILL"));
      }
      return true;
    }
    unref(): void {}
  }

  class FakeSocket extends EventEmitter {
    constructor(readonly url: string) {
      super();
      sockets.push(this);
      setImmediate(() => this.emit("open", {}));
    }
    addEventListener(type: string, listener: (event: any) => void): void {
      this.on(type, listener);
    }
    close(): void {
      setImmediate(() => this.emit("close", {}));
    }
    drop(): void {
      this.emit("close", {});
    }
    private reply(id: number, result: unknown, sessionId?: string): void {
      this.emit("message", { data: JSON.stringify({ id, result, ...(sessionId ? { sessionId } : {}) }) });
    }
    send(data: string): void {
      const message = JSON.parse(data) as { id: number; method: string; params: any; sessionId?: string };
      commands.push({ method: message.method, params: message.params, sessionId: message.sessionId });
      setImmediate(() => {
        switch (message.method) {
          case "Target.createTarget":
            this.reply(message.id, { targetId: `t${++targetCounter}` });
            break;
          case "Target.attachToTarget":
            this.reply(message.id, { sessionId: `s-${message.params.targetId}` });
            break;
          case "Page.navigate":
            this.reply(message.id, { frameId: "f" }, message.sessionId);
            setImmediate(() =>
              this.emit("message", { data: JSON.stringify({ method: "Page.loadEventFired", params: {}, sessionId: message.sessionId }) })
            );
            break;
          case "Page.captureScreenshot": {
            active += 1;
            maxActive = Math.max(maxActive, active);
            const done = (): void => {
              active -= 1;
              this.reply(message.id, { data: PNG_1X1.toString("base64") }, message.sessionId);
            };
            if (options.screenshotGate) gates.push(done);
            else done();
            break;
          }
          default:
            this.reply(message.id, {}, message.sessionId);
        }
      });
    }
  }

  const spawn = (binary: string, args: string[]) => {
    const child = new FakeChild();
    spawns.push({ binary, args, child });
    setImmediate(() => child.stderr.emit("data", Buffer.from("noise\nDevTools listening on ws://127.0.0.1:9222/devtools/browser/abc\n")));
    return child;
  };
  const socketFactory = (url: string) => new FakeSocket(url);
  return {
    spawn,
    socketFactory,
    spawns,
    commands,
    sockets,
    gates,
    get maxActive() {
      return maxActive;
    },
    count: (method: string) => commands.filter((c) => c.method === method).length
  };
}

const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const request = (over: Partial<{ transparent: boolean; width: number; height: number }> = {}) => ({
  html: "<p>x</p>",
  width: 320,
  height: 180,
  transparent: false,
  ...over
});

test("the launch command line is one long-lived headless browser on a DevTools port", () => {
  const plain = chromiumLaunchArgs({ profileDir: "/tmp/x/profile", noSandbox: false });
  assert.ok(plain.includes("--headless=new"));
  assert.ok(plain.includes("--disable-gpu"));
  assert.ok(plain.includes("--remote-debugging-port=0"));
  assert.ok(plain.includes("--user-data-dir=/tmp/x/profile"));
  assert.ok(!plain.includes("--no-sandbox"));
  assert.ok(!plain.some((arg) => arg.startsWith("--screenshot")));
  assert.ok(chromiumLaunchArgs({ profileDir: "/tmp/x/profile", noSandbox: true }).includes("--no-sandbox"));
});

test("a missing browser binary is reported as unavailable", async () => {
  const render = createChromiumFrameRenderer({ binary: "/nonexistent/piprogram-no-browser" });
  await assert.rejects(render(request()), FrameRendererUnavailableError);
  await render.close();
});

test("a render sets the viewport, loads the page, captures a PNG and closes its target", async () => {
  const h = fakeBrowserHarness();
  const render = createChromiumFrameRenderer({ binary: "fake-chromium", noSandbox: true, spawn: h.spawn, socketFactory: h.socketFactory });
  try {
    const png = await render(request({ width: 676, height: 1080 }));
    assert.ok(isPng(png));
    assert.equal(h.spawns.length, 1);
    assert.equal(h.spawns[0]?.binary, "fake-chromium");
    assert.ok(h.spawns[0]?.args.includes("--no-sandbox"));
    assert.equal(h.sockets[0]?.url, "ws://127.0.0.1:9222/devtools/browser/abc");
    const metrics = h.commands.find((c) => c.method === "Emulation.setDeviceMetricsOverride");
    assert.deepEqual(metrics?.params, { width: 676, height: 1080, deviceScaleFactor: 1, mobile: false });
    assert.deepEqual(h.commands.find((c) => c.method === "Emulation.setDefaultBackgroundColorOverride")?.params.color, { r: 255, g: 255, b: 255, a: 1 });
    const nav = h.commands.find((c) => c.method === "Page.navigate");
    assert.match(nav?.params.url, /^file:\/\/.*stage-.*\.html$/);
    assert.equal(h.commands.find((c) => c.method === "Page.captureScreenshot")?.params.format, "png");
    assert.equal(h.count("Target.closeTarget"), 1);

    await render(request({ transparent: true }));
    assert.equal(h.spawns.length, 1, "the browser is reused");
    assert.deepEqual(h.commands.filter((c) => c.method === "Emulation.setDefaultBackgroundColorOverride").at(-1)?.params.color, { r: 0, g: 0, b: 0, a: 0 });
  } finally {
    await render.close();
  }
});

test("renders wait in a queue with concurrency 1, or run together when allowed", async () => {
  for (const [concurrency, expectedMax] of [[1, 1], [2, 2]] as const) {
    const h = fakeBrowserHarness({ screenshotGate: true });
    const render = createChromiumFrameRenderer({ binary: "b", concurrency, spawn: h.spawn, socketFactory: h.socketFactory });
    try {
      const jobs = [render(request()), render(request()), render(request())];
      await tick();
      assert.equal(h.gates.length, expectedMax, `concurrency ${concurrency}`);
      while (h.gates.length) {
        h.gates.shift()?.();
        await tick();
      }
      // Release whatever started afterwards.
      for (let i = 0; i < 5 && h.gates.length; i += 1) {
        h.gates.shift()?.();
        await tick();
      }
      const results = await Promise.all(jobs);
      assert.equal(results.length, 3);
      assert.equal(h.maxActive, expectedMax);
      assert.equal(h.spawns.length, 1);
    } finally {
      await render.close();
    }
  }
});

test("the browser shuts down when idle and starts again on the next render", async () => {
  const h = fakeBrowserHarness();
  const render = createChromiumFrameRenderer({ binary: "b", idleMs: 30, spawn: h.spawn, socketFactory: h.socketFactory });
  try {
    await render(request());
    assert.equal(h.spawns[0]?.child.killed, false);
    await tick(80);
    assert.equal(h.spawns[0]?.child.killed, true);
    await render(request());
    assert.equal(h.spawns.length, 2);
  } finally {
    await render.close();
  }
});

test("the browser is recycled after the maximum number of renders", async () => {
  const h = fakeBrowserHarness();
  const render = createChromiumFrameRenderer({ binary: "b", maxRenders: 2, idleMs: 0, spawn: h.spawn, socketFactory: h.socketFactory });
  try {
    await render(request());
    await render(request());
    await tick();
    assert.equal(h.spawns.length, 1);
    assert.equal(h.spawns[0]?.child.killed, true, "the old browser is stopped after its last render");
    await render(request());
    assert.equal(h.spawns.length, 2);
  } finally {
    await render.close();
  }
});

test("a crashed browser is replaced and the render is retried", async () => {
  const h = fakeBrowserHarness();
  const render = createChromiumFrameRenderer({ binary: "b", idleMs: 0, spawn: h.spawn, socketFactory: h.socketFactory });
  try {
    await render(request());
    h.sockets[0]?.drop(); // the connection is lost
    await tick();
    assert.ok(isPng(await render(request())));
    assert.equal(h.spawns.length, 2);

    // The process dies on its own
    h.spawns[1]?.child.emit("exit", 139, null);
    await tick();
    assert.ok(isPng(await render(request())));
    assert.equal(h.spawns.length, 3);
  } finally {
    await render.close();
  }
});

test("a browser that never answers a render times out and is replaced", async () => {
  const h = fakeBrowserHarness({ screenshotGate: true });
  const render = createChromiumFrameRenderer({ binary: "b", timeoutMs: 40, idleMs: 0, spawn: h.spawn, socketFactory: h.socketFactory });
  try {
    await assert.rejects(render(request()), /did not finish the frame/);
    await tick();
    assert.equal(h.spawns[0]?.child.killed, true);
  } finally {
    await render.close();
  }
});

test("a browser that exits before it is ready fails the render with its output", async () => {
  const spawn = () => {
    const child = new EventEmitter() as any;
    child.stderr = new EventEmitter();
    child.kill = () => true;
    setImmediate(() => {
      child.stderr.emit("data", "boom: no display");
      child.emit("exit", 1, null);
    });
    return child;
  };
  const render = createChromiumFrameRenderer({ binary: "b", spawn });
  await assert.rejects(render(request()), /Browser exited with 1: boom: no display/);
  await render.close();
});

test("the frame route renders the stage at the requested size and alpha", async () => {
  const calls: Array<{ width: number; height: number; transparent: boolean; html: string }> = [];
  const app = buildPipgmServer({
    frameRenderer: async (request) => {
      calls.push(request);
      return PNG_1X1;
    }
  });
  try {
    const res = await app.inject({ method: "GET", url: "/api/v1/pipgm/pipelines/PiPGM1/frame.png" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "image/png");
    assert.deepEqual(res.rawPayload, PNG_1X1);
    assert.equal(calls[0]?.width, 1080);
    assert.equal(calls[0]?.height, 1920);
    assert.equal(calls[0]?.transparent, false);

    const keyed = await app.inject({
      method: "GET",
      url: "/api/v1/pipgm/pipelines/PiPGM1/frame.png?width=676&height=1080&alpha=1"
    });
    assert.equal(keyed.statusCode, 200);
    assert.equal(calls[1]?.width, 676);
    assert.equal(calls[1]?.transparent, true);
    assert.match(calls[1]?.html ?? "", /background: transparent !important/);
    assert.doesNotMatch(calls[0]?.html ?? "", /background: transparent !important/);
  } finally {
    await app.close();
  }
});

test("the frame route refuses bad sizes, unknown pipelines and a missing browser", async () => {
  const app = buildPipgmServer({
    frameRenderer: async () => {
      throw new FrameRendererUnavailableError("Browser not found for the frame route");
    }
  });
  try {
    const bad = await app.inject({ method: "GET", url: "/api/v1/pipgm/pipelines/PiPGM1/frame.png?width=5" });
    assert.equal(bad.statusCode, 422);
    assert.equal(bad.json().error.code, "INVALID_FRAME_SIZE");

    const badAlpha = await app.inject({ method: "GET", url: "/api/v1/pipgm/pipelines/PiPGM1/frame.png?alpha=yes" });
    assert.equal(badAlpha.statusCode, 422);

    const missing = await app.inject({ method: "GET", url: "/api/v1/pipgm/pipelines/PiPGM9/frame.png" });
    assert.equal(missing.statusCode, 404);

    const unavailable = await app.inject({ method: "GET", url: "/api/v1/pipgm/pipelines/PiPGM1/frame.png" });
    assert.equal(unavailable.statusCode, 503);
    assert.equal(unavailable.json().error.code, "FRAME_RENDERER_UNAVAILABLE");
  } finally {
    await app.close();
  }
});

test("the snapshot reports the slide feed with its real size and aspect", async () => {
  const app = buildPipgmServer();
  try {
    const portrait = await app.inject({ method: "GET", url: "/api/v1/pipgm/pipelines/PiPGM1" });
    assert.deepEqual(portrait.json().slideFeed, {
      framePath: "/api/v1/pipgm/pipelines/PiPGM1/frame.png",
      width: 1080,
      height: 1920,
      aspect: "9:16",
      hasSlide: false
    });
    const landscape = await app.inject({ method: "GET", url: "/api/v1/pipgm/pipelines/PiPGM2" });
    assert.equal(landscape.json().slideFeed.aspect, "16:9");
  } finally {
    await app.close();
  }
});

test("aspect labels and the slide feed helper", () => {
  assert.equal(aspectRatioLabel(1080, 1920), "9:16");
  assert.equal(aspectRatioLabel(1920, 1080), "16:9");
  assert.equal(aspectRatioLabel(1200, 1920), "5:8");
  assert.deepEqual(buildSlideFeed("PiPGM2", { width: 1920, height: 1080 }, true), {
    framePath: "/api/v1/pipgm/pipelines/PiPGM2/frame.png",
    width: 1920,
    height: 1080,
    aspect: "16:9",
    hasSlide: true
  });
});
