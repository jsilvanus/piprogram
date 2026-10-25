/**
 * `piprogram` CLI for the PiPGM API. Commands call the client generated from
 * openapi/openapi.yaml (src/generated). Regenerate with `npm run generate`.
 * Set PIPGM_URL (default http://127.0.0.1:3100) and PIPGM_API_KEY.
 */

import { readFile, writeFile } from "node:fs/promises";
import { ApiError, ItemsService, OpenAPI, PipelinesService } from "./generated/index.js";
import { PipgmPipelineId as PipelineId } from "./generated/index.js";

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  baseUrl: string;
  apiKey?: string | undefined;
}

type ControlAction = "next" | "prev" | "gotoStep" | "gotoItem" | "play" | "pause" | "stop" | "restart";

const USAGE = `Usage: piprogram <command>

  pipelines list
  pipelines show <PiPGM1|PiPGM2|PiPGM3>
  pipelines frame <pipelineId> --out <file.png> [--width n] [--height n] [--alpha]
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

const PIPELINES = Object.values(PipelineId) as PipelineId[];
const CONTROL_ACTIONS: ControlAction[] = ["next", "prev", "play", "pause", "stop", "restart", "gotoStep", "gotoItem"];

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

function pipelineArg(value: string | undefined): PipelineId {
  if (!value || !(PIPELINES as string[]).includes(value)) {
    throw new Error(`pipeline must be one of ${PIPELINES.join(", ")}`);
  }
  return value as PipelineId;
}

function controlArg(value: string | undefined): ControlAction {
  if (!value || !(CONTROL_ACTIONS as string[]).includes(value)) {
    throw new Error(`action must be one of ${CONTROL_ACTIONS.join(", ")}`);
  }
  return value as ControlAction;
}

function optionalSide(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be a whole number`);
  return parsed;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  OpenAPI.BASE = io.baseUrl.replace(/\/$/, "");
  OpenAPI.TOKEN = io.apiKey;

  const [group, action, ...rest] = argv;
  if (!group || group === "help" || group === "--help") {
    io.out(USAGE);
    return 0;
  }
  try {
    if (group === "pipelines" && action === "list") {
      const data = await PipelinesService.listPipelines();
      for (const pipeline of data.items) io.out(JSON.stringify(pipeline));
      return 0;
    }
    if (group === "pipelines" && action === "show") {
      io.out(JSON.stringify(await PipelinesService.getPipeline(pipelineArg(rest[0])), null, 2));
      return 0;
    }
    if (group === "pipelines" && action === "frame") {
      const id = pipelineArg(rest[0]);
      const out = flag(rest, "--out");
      if (!out) throw new Error("--out <file.png> is required");
      const width = optionalSide(flag(rest, "--width"), "--width");
      const height = optionalSide(flag(rest, "--height"), "--height");
      // The generated client reads every non-JSON body as text, which would corrupt the PNG,
      // so the binary route is fetched directly with the same query parameters.
      const query = new URLSearchParams();
      if (width !== undefined) query.set("width", String(width));
      if (height !== undefined) query.set("height", String(height));
      if (hasFlag(rest, "--alpha")) query.set("alpha", "1");
      const response = await fetch(`${OpenAPI.BASE}/api/v1/pipgm/pipelines/${encodeURIComponent(id)}/frame.png?${query}`);
      if (!response.ok) throw new Error(`frame request failed (${response.status}): ${await response.text()}`);
      await writeFile(out, Buffer.from(await response.arrayBuffer()));
      io.out(`wrote ${out}`);
      return 0;
    }
    if (group === "pipelines" && action === "control") {
      const id = pipelineArg(rest[0]);
      const name = controlArg(rest[1]);
      const step = flag(rest, "--step");
      const item = flag(rest, "--item");
      await PipelinesService.controlPipeline(id, {
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
      await PipelinesService.setFadeToBlack(id, v === "toggle" ? { toggle: true } : { fadeToBlack: v });
      io.out(`${id}: fade to black ${rest[1]}`);
      return 0;
    }
    if (group === "pipelines" && action === "audio") {
      const id = pipelineArg(rest[0]);
      const v = tristate(rest[1]);
      await PipelinesService.setPipelineAudio(id, v === "toggle" ? { toggle: true } : { audioEnabled: v });
      io.out(`${id}: audio ${rest[1]}`);
      return 0;
    }
    if (group === "pipelines" && action === "orientation") {
      const id = pipelineArg(rest[0]);
      const value = rest[1];
      if (value !== "landscape" && value !== "portrait") throw new Error("orientation must be landscape or portrait");
      await PipelinesService.updatePipelineConfig(id, { orientation: value });
      io.out(`${id}: orientation ${value}`);
      return 0;
    }
    if (group === "pipelines" && action === "playlist" && rest[0] === "add") {
      const id = pipelineArg(rest[1]);
      if (!rest[2]) throw new Error("itemId is required");
      await PipelinesService.addPlaylistItem(id, { itemId: rest[2], cueImmediately: hasFlag(rest, "--cue") });
      io.out(`${id}: added ${rest[2]}`);
      return 0;
    }
    if (group === "pipelines" && action === "playlist" && rest[0] === "remove") {
      const id = pipelineArg(rest[1]);
      if (!rest[2]) throw new Error("itemId is required");
      await PipelinesService.removePlaylistItem(id, rest[2]);
      io.out(`${id}: removed ${rest[2]}`);
      return 0;
    }
    if (group === "items" && action === "list") {
      const data = await ItemsService.listItems();
      for (const item of data.items) io.out(JSON.stringify(item));
      return 0;
    }
    if (group === "items" && action === "show") {
      if (!rest[0]) throw new Error("itemId is required");
      io.out(JSON.stringify(await ItemsService.getItem(rest[0]), null, 2));
      return 0;
    }
    if (group === "items" && action === "youtube") {
      if (!rest[0]) throw new Error("urlOrId is required");
      const target = flag(rest, "--target");
      const item = await ItemsService.createYouTubeItem({
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
      const raw = await readFile(file, "utf8");
      const stanzas = raw
        .split(/\n\s*\n/)
        .map((block) => block.split("\n").map((line) => line.trim()).filter(Boolean))
        .filter((lines) => lines.length > 0)
        .map((lines, index) => ({ stanzaNumber: index + 1, lines }));
      const number = flag(rest, "--number");
      const target = flag(rest, "--target");
      const item = await ItemsService.createHymnItem({
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
    const body = error instanceof ApiError ? (error.body as { error?: { message?: string } } | undefined) : undefined;
    const message = body?.error?.message ?? (error instanceof Error ? error.message : String(error));
    io.err(`piprogram: ${message}`);
    return 1;
  }
}
