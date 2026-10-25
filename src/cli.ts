/**
 * `piprogram` CLI for the PiPGM API. It talks to the server over HTTP using the routes in
 * openapi/openapi.yaml. Set PIPGM_URL (default http://127.0.0.1:3100) and PIPGM_API_KEY.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CliIo {
  fetch: FetchLike;
  out: (text: string) => void;
  err: (text: string) => void;
  baseUrl: string;
  apiKey?: string | undefined;
}

const USAGE = `Usage: piprogram <command>

  pipelines list
  pipelines show <PiPGM1|PiPGM2|PiPGM3>
  pipelines control <pipelineId> <next|prev|play|pause|stop|restart|gotoStep|gotoItem> [--step n] [--item id]
  pipelines ftb <pipelineId> <on|off|toggle>
  pipelines audio <pipelineId> <on|off|toggle>
  pipelines orientation <pipelineId> <landscape|portrait>
  pipelines playlist add <pipelineId> <itemId> [--cue]
  pipelines playlist remove <pipelineId> <itemId>
  items list
  items show <itemId>
  items youtube <urlOrId> [--target <pipelineId>] [--cue]
  items hymn <title> --file <stanzas.txt> [--number n] [--target <pipelineId>] [--cue]
`;

const PIPELINES = ["PiPGM1", "PiPGM2", "PiPGM3"];
const CONTROL_ACTIONS = ["next", "prev", "play", "pause", "stop", "restart", "gotoStep", "gotoItem"];

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function tristate(value: string | undefined): boolean | "toggle" {
  if (value === "on") return true;
  if (value === "off") return false;
  if (value === "toggle") return "toggle";
  throw new Error("expected on, off or toggle");
}

async function call(io: CliIo, method: string, path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (io.apiKey) headers.authorization = `Bearer ${io.apiKey}`;
  const res = await io.fetch(`${io.baseUrl}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = (data as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data;
}

function pipelineArg(value: string | undefined): string {
  if (!value || !PIPELINES.includes(value)) throw new Error(`pipeline must be one of ${PIPELINES.join(", ")}`);
  return value;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [group, action, ...rest] = argv;
  if (!group || group === "help" || group === "--help") {
    io.out(USAGE);
    return 0;
  }
  try {
    if (group === "pipelines" && action === "list") {
      const data = (await call(io, "GET", "/api/v1/pipgm/pipelines")) as { items: Array<Record<string, unknown>> };
      for (const p of data.items) io.out(JSON.stringify(p));
      return 0;
    }
    if (group === "pipelines" && action === "show") {
      io.out(JSON.stringify(await call(io, "GET", `/api/v1/pipgm/pipelines/${pipelineArg(rest[0])}`), null, 2));
      return 0;
    }
    if (group === "pipelines" && action === "control") {
      const id = pipelineArg(rest[0]);
      const name = rest[1];
      if (!name || !CONTROL_ACTIONS.includes(name)) throw new Error(`action must be one of ${CONTROL_ACTIONS.join(", ")}`);
      const step = flag(rest, "--step");
      const item = flag(rest, "--item");
      await call(io, "POST", `/api/v1/pipgm/pipelines/${id}/control`, {
        action: name,
        ...(step !== undefined ? { stepIndex: Number(step) } : {}),
        ...(item !== undefined ? { itemId: item } : {})
      });
      io.out(`${id}: ${name} sent`);
      return 0;
    }
    if (group === "pipelines" && action === "ftb") {
      const id = pipelineArg(rest[0]);
      const v = tristate(rest[1]);
      const body = v === "toggle" ? { toggle: true } : { fadeToBlack: v };
      await call(io, "POST", `/api/v1/pipgm/pipelines/${id}/ftb`, body);
      io.out(`${id}: fade to black ${rest[1]}`);
      return 0;
    }
    if (group === "pipelines" && action === "audio") {
      const id = pipelineArg(rest[0]);
      const v = tristate(rest[1]);
      const body = v === "toggle" ? { toggle: true } : { audioEnabled: v };
      await call(io, "POST", `/api/v1/pipgm/pipelines/${id}/audio`, body);
      io.out(`${id}: audio ${rest[1]}`);
      return 0;
    }
    if (group === "pipelines" && action === "orientation") {
      const id = pipelineArg(rest[0]);
      const value = rest[1];
      if (value !== "landscape" && value !== "portrait") throw new Error("orientation must be landscape or portrait");
      await call(io, "PUT", `/api/v1/pipgm/pipelines/${id}/config`, { orientation: value });
      io.out(`${id}: orientation ${value}`);
      return 0;
    }
    if (group === "pipelines" && action === "playlist" && rest[0] === "add") {
      const id = pipelineArg(rest[1]);
      if (!rest[2]) throw new Error("itemId is required");
      await call(io, "POST", `/api/v1/pipgm/pipelines/${id}/playlist`, {
        itemId: rest[2],
        cueImmediately: hasFlag(rest, "--cue")
      });
      io.out(`${id}: added ${rest[2]}`);
      return 0;
    }
    if (group === "pipelines" && action === "playlist" && rest[0] === "remove") {
      const id = pipelineArg(rest[1]);
      if (!rest[2]) throw new Error("itemId is required");
      await call(io, "DELETE", `/api/v1/pipgm/pipelines/${id}/playlist/${encodeURIComponent(rest[2])}`);
      io.out(`${id}: removed ${rest[2]}`);
      return 0;
    }
    if (group === "items" && action === "list") {
      const data = (await call(io, "GET", "/api/v1/pipgm/items")) as { items: Array<Record<string, unknown>> };
      for (const item of data.items) io.out(JSON.stringify(item));
      return 0;
    }
    if (group === "items" && action === "show") {
      if (!rest[0]) throw new Error("itemId is required");
      io.out(JSON.stringify(await call(io, "GET", `/api/v1/pipgm/items/${encodeURIComponent(rest[0])}`), null, 2));
      return 0;
    }
    if (group === "items" && action === "youtube") {
      if (!rest[0]) throw new Error("urlOrId is required");
      const target = flag(rest, "--target");
      const item = await call(io, "POST", "/api/v1/pipgm/items/youtube", {
        urlOrId: rest[0],
        cueImmediately: hasFlag(rest, "--cue"),
        ...(target !== undefined ? { targetPipelineId: pipelineArg(target) } : {})
      });
      io.out(JSON.stringify(item, null, 2));
      return 0;
    }
    if (group === "items" && action === "hymn") {
      const title = rest[0];
      const file = flag(rest, "--file");
      if (!title || !file) throw new Error("usage: items hymn <title> --file <stanzas.txt>");
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(file, "utf8");
      const stanzas = raw
        .split(/\n\s*\n/)
        .map((block) => block.split("\n").map((line) => line.trim()).filter(Boolean))
        .filter((lines) => lines.length > 0)
        .map((lines, index) => ({ stanzaNumber: index + 1, lines }));
      const number = flag(rest, "--number");
      const target = flag(rest, "--target");
      const item = await call(io, "POST", "/api/v1/pipgm/items/hymn", {
        title,
        stanzas,
        ...(number !== undefined ? { hymnNumber: number } : {}),
        cueImmediately: hasFlag(rest, "--cue"),
        ...(target !== undefined ? { targetPipelineId: pipelineArg(target) } : {})
      });
      io.out(JSON.stringify(item, null, 2));
      return 0;
    }
    io.err(USAGE);
    return 2;
  } catch (error) {
    io.err(`piprogram: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
