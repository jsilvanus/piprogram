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

Not in 1.0: the Canva Connect export route (`items/:id/canva/export`); the push and the export-package routes are below. The effects bridge that pimatrix used for PiPGM fades and mutes is not here; a host that needs it should listen for the pipeline snapshots.

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
- **The stage page is silent unless opened with `?audio=1`** (`/pipgm/:id/stage?audio=1`): no track, and video items stay muted. That is the link the page worker uses to capture a feed's sound; a preview opened at a desk, a frame render (`frame.png`, the piswitch sync) and the publisher's screenshots never play sound. The browser that plays it must be allowed to autoplay (for Chromium: `--autoplay-policy=no-user-gesture-required`).
- A non-looping track that has finished stays in the snapshot as `audioTrack` until it is stopped or the arming ends. Tests: `src/audio.test.ts`. Not tried on the Pi or with a real PA.

## Publishing the feeds to MediaMTX

piprogram can push PiPGM1-3 to MediaMTX itself, so pimatrix does not have to poll for pictures. Set `PIPGM_PUBLISH_RTSP_BASE` (for example `rtsp://127.0.0.1:8554`); the stream of `PiPGM1` is then `<base>/PiPGM1`, the same names pimatrix already routes. Without it nothing is published.

- One long-running ffmpeg per feed reads PNG frames from stdin (`image2pipe`) and publishes H.264 over RTSP (TCP). A timer writes the current picture at `PIPGM_PUBLISH_FPS` (default 5). A slide change only swaps the picture the timer writes, so the stream never drops and there is no black gap on the HDMI side (the old route restarted ffmpeg per slide). ffmpeg restarts by itself with a growing delay if it dies; a changed output size (orientation) restarts it once.
- A fade to black or an empty pipeline publishes a black frame, it does not take the stream down. The basic image, when set, shows as the visual of an idle feed.
- Settings: `PIPGM_PUBLISH_RTSP_BASE`, `PIPGM_PUBLISH_FPS` (1-30), `PIPGM_PUBLISH_ENCODER` (`libx264` default, or `h264_v4l2m2m` for the Pi hardware encoder), `PIPGM_FFMPEG` (binary). `GET /api/v1/pipgm/feeders` (CLI `piprogram feeders`) shows each feed's state.
- **The picture only.** The published stream has no audio track. Sound on a feed is a separate piece of work (the live route).
- **Do not run two publishers.** Turn pimatrix's own PiPGM publishing off (`PIMATRIX_PIPGM_FEED=publish-off`) before enabling this, or both fight for the same stream names.
- Video and embedded items show only their still frame here; moving content needs the live route. Tests: `src/feeder.test.ts` (fake ffmpeg); the PNG frames and the picture swap were checked against a real ffmpeg once. Not tried against MediaMTX or on the Pi.

## Keeping the library in pistorage

By default the media library (uploaded images, audio, video, .pptx files, hymns, Canva items) lives in memory and is gone after a restart. Set `PIPGM_STORAGE_URL` (for example `http://127.0.0.1:3700`) to keep it in [pistorage](https://github.com/jsilvanus/pistorage), which stores the files in S3 and caches them on the Pi.

| Variable | Meaning |
|---|---|
| `PIPGM_STORAGE_URL` | pistorage base URL. Unset = memory only. |
| `PIPGM_STORAGE_API_KEY` | pistorage key, sent as a Bearer token on reads and writes (pistorage wants it for both when it has a key). |
| `PIPGM_STORAGE_PREFIX` | Key prefix, default `piprogram/library`. |

- Each item is stored as `<prefix>/items/<id>.json` and its bytes as `<prefix>/assets/<assetId>`. The bytes are written first, so a listed item always has them.
- At start the items are read back and ids continue after the highest stored one. File bytes are fetched from pistorage when a browser or the stage asks for them (503 if pistorage is down, never a silent empty file).
- A write that fails (pistorage or the bucket is down) keeps the item in memory as *unsaved* and is retried every minute. `GET /api/v1/pipgm/library/storage` lists unsaved items and the last error. If pistorage is down at start, loading is retried the same way.
- `DELETE /api/v1/pipgm/items/{itemId}` removes the item, its files and its places in the playlists.
- Prepared speech is not stored there: it is rebuilt from text and stays in `PIPGM_CACHE_DIR`.
- Canva exports are links, not files, so there is nothing to keep (and no retention deadline) for them yet.
- Not run against a real pistorage or S3; the tests use a fake store and a fake fetch.

## Prepared step pictures and thumbnails

For slide, hymn, image and Canva items piprogram can keep a picture and a small thumbnail of every step, so that a step going on air is read, not rendered by Chromium, and the UI has thumbnails.

- `POST /api/v1/pipgm/items/{id}/prepare {orientation?}` (landscape by default) renders the steps that have no picture yet, one at a time in the background (202; poll `GET .../steps`). `GET /api/v1/pipgm/items/{id}/steps?orientation=` lists the steps with `prepared`, `imageUrl` and `thumbnailUrl`; the pictures are `.../steps/{n}/image.png` and `.../thumbnail.jpg` (320 px wide JPEG, scaled with ffmpeg, `PIPGM_FFMPEG`).
- Pictures are stored in the same store as the library (`PIPGM_STORAGE_URL`, keys `piprogram/steps/<item>/<version>/<orientation>/<n>.png`). The version is a hash of the item's steps and the output size, so an edited item never shows an old picture; old versions are removed when a new one is prepared, and deleting the item removes its pictures. Without `PIPGM_STORAGE_URL` they are kept in memory only.
- The feed publisher uses a prepared picture when there is one and otherwise renders as before, then keeps what it rendered for next time. Video, audio and YouTube items have no step pictures (422).
- Thumbnails are made here, not in pistorage. Not run with a real Chromium, ffmpeg or pistorage; the tests use fakes.

## Canva export packages

The Canva side exports the pages and delivers them to piprogram, which keeps them (nothing is downloaded from Canva by piprogram).

1. `POST /api/v1/pipgm/items/canva {designId|embedUrl, title, ...}` creates the Canva item (201).
1b. `useAt` (optional, on the create call or later with `PUT /api/v1/pipgm/items/{id}/use-at`) says when the presentation is meant to be used: `2026-11-08`, `2026-11-08T10`, `2026-11-08T10:30` or `2026-11-08/2026-11-10`, several separated by commas. It is stored with the item and every file in pistorage, which then fetches them into the Pi cache 48 hours before and keeps them there until 6 hours after (`PIPGM_TIMEZONE`, default Europe/Helsinki, for dates without a zone). The format is in `src/use-at.ts`, a copy of pistorage's. Changing the date later does not send the files again: pistorage changes the date of each stored object in place (`POST /api/v1/use-at`, needs a pistorage with that call), including the prepared step pictures; only the small item JSON is rewritten. Step pictures made afterwards carry the item's date.
2. `POST /api/v1/pipgm/items/{id}/canva/export-package[?orientation=landscape|portrait|landscape,portrait]` delivers the pages as a zip (`Content-Type: application/zip`) or as JSON `{pages:[{filename, mimeType?, pageNumber?, dataBase64}]}`. It answers **202 with a task** (`taskId`, `Location: /api/v1/pipgm/tasks/{taskId}`) at once; the upload progress is the sender's own.
3. `GET /api/v1/pipgm/tasks/{taskId}` reports `state` (`queued`, `unpacking`, `preparing`, `ready`, `failed`), `progress` (0 to 1, never goes back), `pages.total`, `pictures {done,total}` (a step picture with its thumbnail each, per orientation), `saved` (stored in the library store; not needed for ready), `ready` and `error`. `ready: true` means the item can go on air with its pictures prepared; thumbnails are then at `items/{id}/steps/{n}/thumbnail.jpg`.

Details: pages are numbered by the last number in the file name (page-2 before page-10; else natural file order; an explicit `pageNumber` in JSON wins); folders, `__MACOSX`, dot files and non-images (png, jpg, webp) in the zip are ignored; zip64, encrypted entries, more than 300 entries, an entry over 25 MB or 250 MB unpacked are refused (the task fails with the reason). The pages become library assets and the item switches to showing them as slides; the page files and the item JSON get a retention deadline of `PIPGM_CANVA_RETENTION_DAYS` (default 60, 0 = forever) in the store, after which pistorage deletes them. A second package for the same item replaces the first (409 while one is still running). Tasks are kept in memory (the last 50 finished ones), so a restart forgets them; the item itself is stored. The request body limit is 50 MB. Not tried against the real Canva plugin.

Screenshots of the stage page now carry a `<base href>` pointing at this server (`PIPGM_PORT`, or the `selfUrl` option), because the browser loads the page from a temporary file and relative asset URLs such as `/api/v1/pipgm/assets/...` did not resolve before.

## Generated client and CLI

`src/generated/` is generated from `openapi/openapi.yaml` with `openapi-typescript-codegen` (`pnpm run generate`; `prebuild` runs it, so the folder is not committed). The `piprogram` CLI (`dist/cli-main.js`) calls that client and reads `PIPGM_URL` (default `http://127.0.0.1:3200`) and `PIPGM_API_KEY`.

The generated client reads every non-JSON body as text, so it cannot return the frame PNG intact. `piprogram pipelines frame <id> --out file.png [--width n] [--height n] [--alpha]` fetches the frame route directly instead.

## Still in pimatrix

Until the Pi switches over, pimatrix still mounts the old `/api/v1/pipgm/*` routes. They can go once picontrol points at this API.

---

## Pi Ecosystem Integration & Status Updates

This project is an integral component of the [Pi Production Ecosystem](file:///d:/piecosystem).

> [!IMPORTANT]
> Any changes to this repository's architectural role, API routes, communication protocols, exposed ports, dependencies, or runtime status **must be documented in the central `piecosystem` coordination repository** (`docs/projects-catalog.md` and `docs/inter-service-matrix.md`).
> Always verify cross-system health with `npm run status` in `D:\piecosystem`.
