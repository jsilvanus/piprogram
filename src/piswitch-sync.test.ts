import test from "node:test";
import assert from "node:assert/strict";
import { PiPgmService } from "./pipgm-service.js";
import { PiSwitchClient, type SlideAdvanceResult } from "./piswitch-client.js";
import { buildPipgmServer } from "./server.js";

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test("PiPgmService: automatically advances piswitch slide buffer on control action", async () => {
  let advanceCalls = 0;
  let uploadCalls = 0;
  let uploadedSlot = 0;
  let uploadedName = "";

  const mockClient = new PiSwitchClient({
    fetchFn: async (input, init) => {
      const url = input.toString();
      if (url.includes("/slides/advance")) {
        advanceCalls++;
        return new Response(
          JSON.stringify({
            activeSlot: 2,
            cleanedSlot: null,
            lookaheadSlots: [3, 4, 5, 6, 1],
            mediaPlayer: 1
          } satisfies SlideAdvanceResult),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/slots/")) {
        uploadCalls++;
        const match = url.match(/\/slots\/(\d+)/);
        uploadedSlot = match ? Number(match[1]) : 0;
        const nameMatch = url.match(/name=([^&]+)/);
        uploadedName = nameMatch ? decodeURIComponent(nameMatch[1]) : "";
        return new Response(
          JSON.stringify({ slot: uploadedSlot, pool: "slides", bytes: 100 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("{}", { status: 200 });
    }
  });

  const fakeFrameRenderer = async () => PNG_1X1;

  const service = new PiPgmService({
    piswitchClient: mockClient,
    autoSyncPiswitch: true,
    frameRenderer: fakeFrameRenderer
  });

  // Create a hymn so we have multiple steps
  const hymn = service.createHymnItem({
    title: "Sync Test Hymn",
    hymnNumber: "42",
    includeTitleSlide: true,
    stanzas: [{ lines: ["Line 1", "Line 2"] }, { lines: ["Line 3", "Line 4"] }],
    targetPipelineId: "PiPGM1",
    cueImmediately: true
  });

  assert.ok(hymn);

  // Perform "next" action
  service.control("PiPGM1", { action: "next" });

  // Wait a short tick for the asynchronous background sync to complete
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(advanceCalls, 1, "advanceSlide should have been called once");
  assert.equal(uploadCalls, 1, "uploadStill should have been called once");
  assert.equal(uploadedSlot, 2, "uploaded to activeSlot 2");
  assert.equal(uploadedName, "pipgm-PiPGM1-step1");
});

test("PiPgmService: gracefully ignores piswitch failures without corrupting pipeline state", async () => {
  const failingClient = new PiSwitchClient({
    fetchFn: async () => {
      throw new Error("Connection refused to piswitch");
    }
  });

  const service = new PiPgmService({
    piswitchClient: failingClient,
    autoSyncPiswitch: true
  });

  // Advance should not throw
  const res = service.control("PiPGM1", { action: "next" });
  assert.ok(res);

  // Manual sync should return null instead of throwing
  const syncRes = await service.syncToPiSwitch("PiPGM1");
  assert.equal(syncRes, null);
});

test("server route /api/v1/pipgm/pipelines/:id/sync-piswitch returns 503 when piswitch not configured", async () => {
  const app = buildPipgmServer({
    // no piswitchClient, no PISWITCH_URL
  });

  const res = await app.inject({
    method: "POST",
    url: "/api/v1/pipgm/pipelines/PiPGM1/sync-piswitch"
  });

  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, "PISWITCH_NOT_CONFIGURED");
});

test("server route /api/v1/pipgm/pipelines/:id/sync-piswitch returns 200 with result when configured", async () => {
  const mockClient = new PiSwitchClient({
    fetchFn: async (input) => {
      if (input.toString().includes("/slides/advance")) {
        return new Response(
          JSON.stringify({
            activeSlot: 1,
            cleanedSlot: 5,
            lookaheadSlots: [2, 3, 4, 5, 6],
            mediaPlayer: 1
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("{}", { status: 200 });
    }
  });

  const app = buildPipgmServer({
    piswitchClient: mockClient,
    frameRenderer: async () => PNG_1X1
  });

  const res = await app.inject({
    method: "POST",
    url: "/api/v1/pipgm/pipelines/PiPGM1/sync-piswitch"
  });

  assert.equal(res.statusCode, 200);
  const data = res.json();
  assert.equal(data.synced, true);
  assert.equal(data.slideBuffer.activeSlot, 1);
  assert.equal(data.slideBuffer.cleanedSlot, 5);
});
