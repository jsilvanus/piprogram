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

## Still in pimatrix

Routes `/api/v1/pipgm/*` and `/pipgm/:id/stage` are still mounted by pimatrix `app.ts`. They move into this service with its own OpenAPI and generated CLI.
