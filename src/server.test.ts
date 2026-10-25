import assert from "node:assert/strict";
import test from "node:test";
import { buildPipgmServer } from "./server.js";

test("lists the three pipelines and reads one", async () => {
  const app = buildPipgmServer();
  try {
    const list = await app.inject({ method: "GET", url: "/api/v1/pipgm/pipelines" });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().items.length, 3);
    const one = await app.inject({ method: "GET", url: "/api/v1/pipgm/pipelines/PiPGM1" });
    assert.equal(one.statusCode, 200);
    const missing = await app.inject({ method: "GET", url: "/api/v1/pipgm/pipelines/PiPGM9" });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, "PIPELINE_NOT_FOUND");
  } finally {
    await app.close();
  }
});

test("control rejects unknown actions and bad indexes with 422", async () => {
  const app = buildPipgmServer();
  try {
    const bad = await app.inject({ method: "POST", url: "/api/v1/pipgm/pipelines/PiPGM1/control", payload: { action: "explode" } });
    assert.equal(bad.statusCode, 422);
    assert.equal(bad.json().error.code, "INVALID_CONTROL_ACTION");
    const index = await app.inject({
      method: "POST",
      url: "/api/v1/pipgm/pipelines/PiPGM1/control",
      payload: { action: "gotoStep", stepIndex: -1 }
    });
    assert.equal(index.statusCode, 422);
    assert.equal(index.json().error.code, "INVALID_STEP_INDEX");
  } finally {
    await app.close();
  }
});

test("a hymn can be created and read back from the library", async () => {
  const app = buildPipgmServer();
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/pipgm/items/hymn",
      payload: { title: "Testihymni", stanzas: [{ stanzaNumber: 1, lines: ["ensimmäinen säe"] }] }
    });
    assert.equal(created.statusCode, 201);
    const id = created.json().id as string;
    const read = await app.inject({ method: "GET", url: `/api/v1/pipgm/items/${id}` });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().title, "Testihymni");
  } finally {
    await app.close();
  }
});

test("a YouTube URL that holds no video ID is refused", async () => {
  const app = buildPipgmServer();
  try {
    const res = await app.inject({ method: "POST", url: "/api/v1/pipgm/items/youtube", payload: { urlOrId: "https://example.com/x" } });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.code, "INVALID_YOUTUBE_URL");
  } finally {
    await app.close();
  }
});

test("the stage page is served as HTML", async () => {
  const app = buildPipgmServer();
  try {
    const res = await app.inject({ method: "GET", url: "/pipgm/PiPGM2/stage" });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /text\/html/);
  } finally {
    await app.close();
  }
});

test("with an API key, writes need the key and reads stay open", async () => {
  const app = buildPipgmServer({ apiKey: "s3cret-key" });
  try {
    const read = await app.inject({ method: "GET", url: "/api/v1/pipgm/pipelines" });
    assert.equal(read.statusCode, 200);
    const anonymous = await app.inject({ method: "POST", url: "/api/v1/pipgm/items/hymn", payload: { title: "x" } });
    assert.equal(anonymous.statusCode, 401);
    const bearer = await app.inject({
      method: "POST",
      url: "/api/v1/pipgm/items/hymn",
      headers: { authorization: "Bearer s3cret-key" },
      payload: { title: "x" }
    });
    assert.equal(bearer.statusCode, 201);
    const header = await app.inject({
      method: "POST",
      url: "/api/v1/pipgm/items/hymn",
      headers: { "x-api-key": "s3cret-key" },
      payload: { title: "y" }
    });
    assert.equal(header.statusCode, 201);
  } finally {
    await app.close();
  }
});
