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

test("playlist/steps lists every step of the playlist in order and marks the active one", async () => {
  const app = buildPipgmServer();
  try {
    const ids: string[] = [];
    for (const title of ["Eka", "Toka"]) {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/pipgm/items/hymn",
        payload: { title, stanzas: [{ stanzaNumber: 1, lines: ["a"] }, { stanzaNumber: 2, lines: ["b"] }] }
      });
      ids.push(created.json().id as string);
      await app.inject({ method: "POST", url: "/api/v1/pipgm/pipelines/PiPGM1/playlist", payload: { itemId: ids.at(-1) } });
    }
    await app.inject({ method: "POST", url: "/api/v1/pipgm/pipelines/PiPGM1/control", payload: { action: "gotoItem", itemId: ids[1] } });
    const res = await app.inject({ method: "GET", url: "/api/v1/pipgm/pipelines/PiPGM1/playlist/steps" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.pipelineId, "PiPGM1");
    assert.equal(body.activeItemId, ids[1]);
    const rows = body.steps as Array<{ itemId: string; itemIndex: number; stepIndex: number; thumbnailUrl: string | null; isActive: boolean }>;
    assert.ok(rows.length >= 2);
    assert.deepEqual([...new Set(rows.map((r) => r.itemId))], ids);
    assert.deepEqual(rows.filter((r) => r.isActive).map((r) => [r.itemId, r.stepIndex]), [[ids[1], 0]]);
    assert.ok(rows.every((r) => r.thumbnailUrl === null));
    const missing = await app.inject({ method: "GET", url: "/api/v1/pipgm/pipelines/PiPGM9/playlist/steps" });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("playlist/order reorders, replaces and refuses unknown or repeated ids without changing anything", async () => {
  const app = buildPipgmServer();
  try {
    const ids: string[] = [];
    for (const title of ["A", "B", "C"]) {
      const created = await app.inject({ method: "POST", url: "/api/v1/pipgm/items/hymn", payload: { title, stanzas: [{ lines: ["x"] }] } });
      ids.push(created.json().id as string);
    }
    const put = (itemIds: unknown) =>
      app.inject({ method: "PUT", url: "/api/v1/pipgm/pipelines/PiPGM1/playlist/order", payload: { itemIds } });
    const titles = async () =>
      ((await app.inject({ method: "GET", url: "/api/v1/pipgm/pipelines/PiPGM1" })).json().playlist as Array<{ title: string }>).map((i) => i.title);

    assert.equal((await put([ids[0], ids[1]])).statusCode, 200);
    assert.deepEqual(await titles(), ["A", "B"]);
    // the first item is active; reordering keeps it active at step 0
    const reordered = await put([ids[1], ids[2], ids[0]]);
    assert.equal(reordered.json().activeItemId, ids[0]);
    assert.deepEqual(await titles(), ["B", "C", "A"]);
    // dropping the active item moves the active one to the first remaining
    const dropped = await put([ids[2], ids[1]]);
    assert.equal(dropped.json().activeItemId, ids[2]);

    const unknown = await put([ids[1], "nope"]);
    assert.equal(unknown.statusCode, 422);
    assert.equal(unknown.json().error.code, "UNKNOWN_ITEMS");
    const dup = await put([ids[1], ids[1]]);
    assert.equal(dup.statusCode, 422);
    assert.equal(dup.json().error.code, "DUPLICATE_ITEMS");
    assert.equal((await put("x")).statusCode, 422);
    assert.deepEqual(await titles(), ["C", "B"]);

    assert.equal((await put([])).json().activeItemId, null);
    assert.equal((await app.inject({ method: "PUT", url: "/api/v1/pipgm/pipelines/PiPGM9/playlist/order", payload: { itemIds: [] } })).statusCode, 404);
  } finally {
    await app.close();
  }
});
