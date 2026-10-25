import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli.js";
import { buildPipgmServer } from "./server.js";

test("the CLI lists pipelines and reports API errors against a live server", async () => {
  const app = buildPipgmServer();
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = address.replace(/\/$/, "");
  const lines: string[] = [];
  const errors: string[] = [];
  const io = {
    out: (text: string) => lines.push(text),
    err: (text: string) => errors.push(text),
    baseUrl
  };
  try {
    assert.equal(await runCli(["pipelines", "list"], io), 0);
    assert.equal(lines.length, 3);
    assert.equal(await runCli(["pipelines", "show", "PiPGM9"], io), 1);
    assert.match(errors.join("\n"), /pipeline must be one of/);
    assert.equal(await runCli(["pipelines", "control", "PiPGM1", "explode"], io), 1);
    assert.equal(await runCli(["nonsense"], io), 2);
  } finally {
    await app.close();
  }
});

test("the CLI saves a pipeline frame as PNG through the frame route", async () => {
  const pngBytes = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const app = buildPipgmServer({ frameRenderer: async () => pngBytes });
  const baseUrl = (await app.listen({ host: "127.0.0.1", port: 0 })).replace(/\/$/, "");
  const dir = await mkdtemp(join(tmpdir(), "piprogram-cli-frame-"));
  const out = join(dir, "slide.png");
  const lines: string[] = [];
  const errors: string[] = [];
  const io = { out: (text: string) => lines.push(text), err: (text: string) => errors.push(text), baseUrl };
  try {
    assert.equal(await runCli(["pipelines", "frame", "PiPGM1", "--out", out, "--width", "676", "--alpha"], io), 0);
    assert.deepEqual(await readFile(out), pngBytes);
    assert.equal(await runCli(["pipelines", "frame", "PiPGM1"], io), 1);
    assert.match(errors.join("\n"), /--out/);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
