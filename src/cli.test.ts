import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "./cli.js";
import { buildPipgmServer } from "./server.js";

test("the CLI lists pipelines and reports API errors against a live server", async () => {
  const app = buildPipgmServer();
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = address.replace(/\/$/, "");
  const lines: string[] = [];
  const errors: string[] = [];
  const io = {
    fetch: (url: string, init?: RequestInit) => fetch(url, init),
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
