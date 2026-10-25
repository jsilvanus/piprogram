# piprogram

Content for distribution: hymns, slides, PPTX, Canva integration and the stage page.

Extracted from `jsilvanus/pimatrix` (`packages/api/src/pipgm`).

## Build and test

```bash
npm install
npm run build   # tsc -p tsconfig.json -> dist/
npm test        # build, then node --test (no test files yet)
```

Requires Node.js 24 or later. Dependencies: `typescript` and `@types/node` only.

## Seam interfaces

The code does not import from pimatrix. The two types it used to take from there are defined locally in `src/types/external.ts`:

- `ManagedStreamSnapshot`: the stream fields the service reads and writes (`state`, `jobId`, `attempt`, `lastError`, `stderrTail`).
- `PiMatrixEventBroker`: the single `emit({ type, data })` method the service calls. It is optional at the call site.

A host that embeds piprogram must provide objects that satisfy these interfaces. They are not copies of the pimatrix implementations.

## HTTP API (1.0)

`npm start` runs the PiPGM API (`PIPGM_PORT`, default 3100; `PIPGM_HOST`, default 127.0.0.1; `PIPGM_API_KEY` required for any non-loopback host). Routes and error shapes match the old pimatrix `/api/v1/pipgm/*` routes, so clients keep working; the contract is `openapi/openapi.yaml`.

- Pipelines: list, read, config, control, ftb, audio, playlist add/remove
- Library items: list, read, hymn, YouTube, media, PPTX, asset bytes
- Stage page: `GET /pipgm/:pipelineId/stage`

Writes need `Authorization: Bearer <key>` or `x-api-key` when a key is set. Reads stay open.

Not in 1.0: the Canva routes (`/api/v1/pipgm/canva/*`, `/api/v1/pipgm/items/canva`, `items/:id/canva/export`). They come in 1.1 with the Canva integration. The effects bridge that pimatrix used for PiPGM fades and mutes is not here; a host that needs it should listen for the pipeline snapshots.

## Generated client and CLI

`src/generated/` is generated from `openapi/openapi.yaml` with `openapi-typescript-codegen` (`npm run generate`; `prebuild` runs it, so the folder is not committed). The `piprogram` CLI (`dist/cli-main.js`) calls that client and reads `PIPGM_URL` (default `http://127.0.0.1:3100`) and `PIPGM_API_KEY`.

## Still in pimatrix

Until the Pi switches over, pimatrix still mounts the old `/api/v1/pipgm/*` routes. They can go once picontrol points at this API.
