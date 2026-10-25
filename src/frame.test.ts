import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromiumScreenshotArgs, createChromiumFrameRenderer, FrameRendererUnavailableError, isPng } from "./frame.js";
import { buildPipgmServer } from "./server.js";
import { aspectRatioLabel, buildSlideFeed } from "./pipgm-model.js";

// 1x1 transparent PNG
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

test("the screenshot command line keeps alpha only when asked", () => {
  const base = {
    htmlPath: "/tmp/x/stage.html",
    outPath: "/tmp/x/frame.png",
    profileDir: "/tmp/x/profile",
    width: 676,
    height: 1080,
    noSandbox: false
  };
  const opaque = chromiumScreenshotArgs({ ...base, transparent: false });
  assert.ok(opaque.includes("--window-size=676,1080"));
  assert.ok(opaque.includes("--screenshot=/tmp/x/frame.png"));
  assert.ok(opaque.some((arg) => arg.startsWith("--user-data-dir=")));
  assert.ok(!opaque.some((arg) => arg.startsWith("--default-background-color")));
  assert.equal(opaque.at(-1), "file:///tmp/x/stage.html");

  const keyed = chromiumScreenshotArgs({ ...base, transparent: true, noSandbox: true });
  assert.ok(keyed.includes("--default-background-color=00000000"));
  assert.ok(keyed.includes("--no-sandbox"));
});

test("a missing browser binary is reported as unavailable", async () => {
  const render = createChromiumFrameRenderer({ binary: "/nonexistent/piprogram-no-browser" });
  await assert.rejects(
    render({ html: "<p>x</p>", width: 16, height: 16, transparent: false }),
    FrameRendererUnavailableError
  );
});

test("the default renderer runs the browser and returns the PNG it writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "piprogram-fake-browser-"));
  try {
    // Stands in for chromium: writes the PNG to the --screenshot path and exits 0.
    const script = join(dir, "fake-chromium.mjs");
    await writeFile(
      script,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const arg = process.argv.find((a) => a.startsWith("--screenshot="));
writeFileSync(arg.slice("--screenshot=".length), Buffer.from(${JSON.stringify(PNG_1X1.toString("base64"))}, "base64"));
`
    );
    await chmod(script, 0o755);
    const render = createChromiumFrameRenderer({ binary: script });
    const png = await render({ html: "<p>x</p>", width: 16, height: 16, transparent: true });
    assert.ok(isPng(png));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
