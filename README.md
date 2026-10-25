# piprogram

Content for distribution: hymns, slides, PPTX, Canva integration and the stage page.

Extracted from `jsilvanus/pimatrix` (`packages/api/src/pipgm`). Status: phase A, files copied as-is, not yet compiling on their own.

Open seams to replace before this builds on its own:
- `stream-supervisor.js` (`ManagedStreamSnapshot` type) comes from pimatrix.
- `events.js` (`PiMatrixEventBroker`) comes from pimatrix.
- Routes `/api/v1/pipgm/*` and `/pipgm/:id/stage` are still mounted by pimatrix `app.ts`. They move into this service with its own OpenAPI and generated CLI.
