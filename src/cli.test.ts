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

test("the CLI saves, exports, imports, loads and deletes playlists and lists the steps", async () => {
  const app = buildPipgmServer();
  const baseUrl = (await app.listen({ host: "127.0.0.1", port: 0 })).replace(/\/$/, "");
  const dir = await mkdtemp(join(tmpdir(), "piprogram-cli-pl-"));
  const lines: string[] = [];
  const errors: string[] = [];
  const io = { out: (text: string) => lines.push(text), err: (text: string) => errors.push(text), baseUrl };
  const last = () => lines.at(-1)!;
  try {
    const hymn = (await app.inject({ method: "POST", url: "/api/v1/pipgm/items/hymn", payload: { title: "V", hymnNumber: "5", stanzas: [{ lines: ["a"] }] } })).json().id as string;
    assert.equal(await runCli(["pipelines", "playlist", "order", "PiPGM1", hymn], io), 0);
    assert.equal(await runCli(["pipelines", "playlist", "steps", "PiPGM1"], io), 0);
    assert.match(last(), new RegExp(`${hymn} hymn`));

    assert.equal(await runCli(["playlists", "save", "PiPGM1", "Sunday"], io), 0);
    const id = last().split(" ")[0]!;
    assert.match(id, /^pl-/);
    assert.equal(await runCli(["playlists", "list"], io), 0);
    assert.match(last(), /Sunday/);

    const file = join(dir, "sunday.json");
    assert.equal(await runCli(["playlists", "export", id, "--out", file], io), 0);
    const exported = JSON.parse(await readFile(file, "utf8"));
    assert.equal(exported.id, undefined);
    assert.equal(exported.items[0].hymn.number, 5);
    assert.equal(await runCli(["playlists", "import", file, "--name", "Copy"], io), 0);
    assert.equal(await runCli(["playlists", "list"], io), 0);
    assert.equal(lines.filter((l) => l.startsWith("pl-")).length >= 3, true);

    assert.equal(await runCli(["pipelines", "playlist", "order", "PiPGM1"], io), 0);
    assert.equal(await runCli(["playlists", "load", "PiPGM1", id], io), 0);
    assert.ok(lines.some((l) => l.includes("1 found, 0 missing")));
    assert.equal(await runCli(["playlists", "load", "PiPGM1", "pl-000000000000"], io), 1);
    assert.match(errors.join("\n"), /Unknown saved playlist/);

    assert.equal(await runCli(["playlists", "generate", "2026-11-22", "--out", file], io), 0);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).items, []);
    assert.equal(await runCli(["playlists", "delete", id], io), 0);
    assert.equal(await runCli(["playlists", "get", id], io), 1);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
