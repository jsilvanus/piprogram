# piprogram

Content for distribution: hymns, slides, PPTX, Canva integration and the stage page.

Extracted from `jsilvanus/pimatrix` (`packages/api/src/pipgm`).

## Build and test

```bash
pnpm install
pnpm run build   # tsc -p tsconfig.json -> dist/
pnpm test        # build, then node --test (no test files yet)
```

Requires Node.js 24 or later. Dependencies: `typescript` and `@types/node` only.

## Seam interfaces

The code does not import from pimatrix. The two types it used to take from there are defined locally in `src/types/external.ts`:

- `ManagedStreamSnapshot`: the stream fields the service reads and writes (`state`, `jobId`, `attempt`, `lastError`, `stderrTail`).
- `PiMatrixEventBroker`: the single `emit({ type, data })` method the service calls. It is optional at the call site.

A host that embeds piprogram must provide objects that satisfy these interfaces. They are not copies of the pimatrix implementations.

## HTTP API (1.0)

`pnpm start` runs the PiPGM API (`PIPGM_PORT`, default 3200; `PIPGM_HOST`, default 127.0.0.1; `PIPGM_API_KEY` required for any non-loopback host). Routes and error shapes match the old pimatrix `/api/v1/pipgm/*` routes, so clients keep working; the contract is `openapi/openapi.yaml`.

- Pipelines: list, read, config, control, ftb, audio, playlist add/remove
- Library items: list, read, hymn, YouTube, media, PPTX, asset bytes
- Stage page: `GET /pipgm/:pipelineId/stage`
- Slide frame: `GET /api/v1/pipgm/pipelines/:pipelineId/frame.png?width=&height=&alpha=` renders the current stage as a PNG (default size = the pipeline resolution). `alpha=1` leaves the stage background out, so the picture keeps alpha. It needs a headless Chromium: `PIPGM_CHROMIUM` (default `chromium`; `PIPGM_CHROMIUM_NO_SANDBOX=1` only when running as root). Without one it answers 503. A fade to black is not applied to the picture; read `fadeToBlack` from the pipeline.
- Pipeline snapshots carry `slideFeed`: the frame path, the real size, the aspect (portrait is 9:16 at 1080x1920, not the projectors' 10:16 preset) and `hasSlide`.

Writes need `Authorization: Bearer <key>` or `x-api-key` when a key is set. Reads stay open.

Not in 1.0: the Canva routes (`/api/v1/pipgm/canva/*`, `/api/v1/pipgm/items/canva`, `items/:id/canva/export`). They come in 1.1 with the Canva integration. The effects bridge that pimatrix used for PiPGM fades and mutes is not here; a host that needs it should listen for the pipeline snapshots.

## Audio and the basic image

Each of the three feeds has **visual content** (the active item, or black) and, separately, **audio content** (a track). A video item carries its own sound as before. piprogram only outputs the feed; where the sound ends up after the Atlona (the PA, via the left projector on output 1) is not its concern.

- **Arm state:** sound is off by default. `POST /pipelines/:id/audio {audioEnabled:true, armSeconds?}` arms it for `armSeconds` (default `PIPGM_AUDIO_ARM_SECONDS`, 900; at most 3600). When the time ends the feed is disarmed by itself, the track stops, and video items on it go silent. `audioArmedUntil` shows the end.
- **Play:** `POST /pipelines/:id/audio/play {itemId, loop?, volume?}` starts an audio library item (create one with `POST /items/media {kind:"audio"}`). Refused with 409 `AUDIO_NOT_ARMED` unless armed. `POST .../audio/stop` stops the track and leaves the feed armed. The sound fades in over 1.5 s.
- **Gain cap:** `PIPGM_AUDIO_MAX_VOLUME` (default 60) is the highest volume any feed plays at. `volume` is what was asked for, `effectiveVolume` what the stage plays (applies to video items too).
- **Kill switch:** `POST /api/v1/pipgm/audio/kill` stops every track, disarms and mutes all feeds at once (CLI: `piprogram audio kill`). It needs the API key like any write.
- **Basic image:** `PUT /pipelines/:id/basic-image {itemId|null}` picks an image library item that a feed shows when nothing else is active. The default stays black.
- **Text to speech (prepare):** `POST /api/v1/pipgm/tts/prepare {text, voice?}` renders the phrase to a WAV ahead of time and returns it as an audio library item (CLI: `piprogram tts prepare "<text>"`); play it later with `audio/play`. The same text and voice give the same item back (200, `cached`). Engine: [Piper](https://github.com/rhasspy/piper), offline, with Finnish voices such as `fi_FI-harri-medium`; piprogram does not bundle it. Install the binary and put the voice files (`<voice>.onnx` and `<voice>.onnx.json`) in a directory, then set `PIPGM_TTS_MODEL_DIR` (and `PIPGM_TTS_VOICE`, `PIPGM_TTS_PIPER`, `PIPGM_TTS_TIMEOUT_MS`). Without `PIPGM_TTS_MODEL_DIR` the route answers 503 `TTS_NOT_CONFIGURED`. Check the licence of the voice you choose.
- **Limits on audio files** (prepared speech and uploads alike): `PIPGM_TTS_MAX_CHARS` (500 characters of text), `PIPGM_TTS_MAX_SECONDS` (60 s; a WAV is read from its header, so an upload longer than this is refused with 422), `PIPGM_AUDIO_MAX_BYTES` (20 MB; uploads over it get 413). Prepared phrases are cached on disk in `PIPGM_CACHE_DIR` (default `./data/cache/tts`, a WAV plus a small JSON per phrase), survive restarts and are streamed from the file (with Range), not held in memory; their ids are stable (`tts-<hash>`). Beyond `PIPGM_TTS_MAX_ITEMS` (50) or `PIPGM_TTS_MAX_TOTAL_BYTES` (100 MB) the oldest is dropped (never the one that is playing). One render runs at a time and at most three wait (429 `TTS_BUSY`).
- **Uploading WAV files:** `POST /items/media {kind:"audio", filename, mimeType:"audio/wav", dataBase64}` is the same as preparing; a valid WAV within the limits becomes an audio item with its duration. Other audio formats (mp3 and so on) are only size-checked.
- The browser that shows the stage page must be allowed to autoplay (for Chromium: `--autoplay-policy=no-user-gesture-required`). Frame renders (`frame.png`, the piswitch sync) never play sound.
- A non-looping track that has finished stays in the snapshot as `audioTrack` until it is stopped or the arming ends. Tests: `src/audio.test.ts`. Not tried on the Pi or with a real PA.

## Generated client and CLI

`src/generated/` is generated from `openapi/openapi.yaml` with `openapi-typescript-codegen` (`pnpm run generate`; `prebuild` runs it, so the folder is not committed). The `piprogram` CLI (`dist/cli-main.js`) calls that client and reads `PIPGM_URL` (default `http://127.0.0.1:3200`) and `PIPGM_API_KEY`.

The generated client reads every non-JSON body as text, so it cannot return the frame PNG intact. `piprogram pipelines frame <id> --out file.png [--width n] [--height n] [--alpha]` fetches the frame route directly instead.

## Still in pimatrix

Until the Pi switches over, pimatrix still mounts the old `/api/v1/pipgm/*` routes. They can go once picontrol points at this API.
