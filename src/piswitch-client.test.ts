import test from "node:test";
import assert from "node:assert/strict";
import { PiSwitchClient, PiSwitchError } from "./piswitch-client.js";

test("PiSwitchClient: uses default URL or environment variable", () => {
  const client1 = new PiSwitchClient({ baseUrl: "http://example.com:3200/" });
  assert.equal(client1.configuredUrl, "http://example.com:3200");

  const client2 = new PiSwitchClient({});
  assert.ok(client2.configuredUrl.length > 0);
});

test("PiSwitchClient: getSlideStatus calls status endpoint", async () => {
  const mockFetch: typeof fetch = async (input, init) => {
    assert.equal(input.toString(), "http://mock-piswitch:3200/api/v1/video-mixer/media-pool/slides/status");
    assert.equal(init?.method, "GET");
    return new Response(
      JSON.stringify({
        currentSlot: 1,
        previousSlot: null,
        lookaheadSlots: [2, 3, 4, 5, 6],
        cleanedSlot: null,
        totalSlots: 6
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const client = new PiSwitchClient({
    baseUrl: "http://mock-piswitch:3200",
    fetchFn: mockFetch
  });

  const status = await client.getSlideStatus();
  assert.equal(status.currentSlot, 1);
  assert.deepEqual(status.lookaheadSlots, [2, 3, 4, 5, 6]);
});

test("PiSwitchClient: advanceSlide calls advance endpoint with optional slot", async () => {
  let calledBody: string | undefined;
  const mockFetch: typeof fetch = async (input, init) => {
    assert.equal(input.toString(), "http://mock-piswitch:3200/api/v1/video-mixer/media-pool/slides/advance");
    assert.equal(init?.method, "POST");
    const headers = init?.headers as Record<string, string> | undefined;
    assert.equal(headers?.["Authorization"], "Bearer secret-token");
    calledBody = init?.body?.toString();
    return new Response(
      JSON.stringify({
        activeSlot: 3,
        cleanedSlot: 1,
        lookaheadSlots: [4, 5, 6, 1, 2],
        mediaPlayer: 1
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const client = new PiSwitchClient({
    baseUrl: "http://mock-piswitch:3200",
    apiKey: "secret-token",
    fetchFn: mockFetch
  });

  const res = await client.advanceSlide(3);
  assert.equal(res.activeSlot, 3);
  assert.equal(res.cleanedSlot, 1);
  assert.equal(JSON.parse(calledBody!).slot, 3);
});

test("PiSwitchClient: uploadStill sends raw binary to slot", async () => {
  let calledUrl = "";
  let calledMethod = "";
  let calledBody: any = null;

  const mockFetch: typeof fetch = async (input, init) => {
    calledUrl = input.toString();
    calledMethod = init?.method ?? "";
    calledBody = init?.body;
    return new Response(
      JSON.stringify({
        slot: 4,
        name: "test-slide",
        pool: "slides",
        bytes: 8
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const client = new PiSwitchClient({
    baseUrl: "http://mock-piswitch:3200",
    fetchFn: mockFetch
  });

  const dummyBytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const res = await client.uploadStill(4, dummyBytes, "test-slide");
  assert.equal(calledUrl, "http://mock-piswitch:3200/api/v1/video-mixer/media-pool/slots/4?pool=slides&name=test-slide");
  assert.equal(calledMethod, "PUT");
  assert.equal(res.slot, 4);
  assert.equal(res.bytes, 8);
});

test("PiSwitchClient: setMediaPlayerSource sets source slot", async () => {
  const mockFetch: typeof fetch = async (input, init) => {
    assert.equal(input.toString(), "http://mock-piswitch:3200/api/v1/video-mixer/media-players/1/source");
    assert.equal(init?.method, "PUT");
    return new Response(
      JSON.stringify({ player: 1, stillSlot: 2 }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const client = new PiSwitchClient({
    baseUrl: "http://mock-piswitch:3200",
    fetchFn: mockFetch
  });

  const res = await client.setMediaPlayerSource(1, 2);
  assert.equal(res.player, 1);
  assert.equal(res.stillSlot, 2);
});

test("PiSwitchClient: handles API errors gracefully", async () => {
  const mockFetch: typeof fetch = async () => {
    return new Response(
      JSON.stringify({ error: { code: "SLOT_NOT_FOUND", message: "Slot 99 not found" } }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  };

  const client = new PiSwitchClient({
    baseUrl: "http://mock-piswitch:3200",
    fetchFn: mockFetch
  });

  await assert.rejects(
    async () => client.getSlideStatus(),
    (err: PiSwitchError) => {
      assert.equal(err.statusCode, 404);
      assert.equal(err.code, "SLOT_NOT_FOUND");
      assert.equal(err.message, "Slot 99 not found");
      return true;
    }
  );
});

test("PiSwitchClient: isAvailable returns true on success and false on failure", async () => {
  const goodClient = new PiSwitchClient({
    fetchFn: async () => new Response("ok", { status: 200 })
  });
  assert.equal(await goodClient.isAvailable(), true);

  const badClient = new PiSwitchClient({
    fetchFn: async () => { throw new Error("Connection refused"); }
  });
  assert.equal(await badClient.isAvailable(), false);
});
