/**
 * Renders the stage page of one pipeline to a PNG, so a client can read the current slide
 * as a still (pimatrix's slide composite). The renderer is a headless Chromium
 * (`PIPGM_CHROMIUM`, default `chromium`) taking a screenshot of a local HTML file: no
 * browser library is linked in, and the page's own script never talks to the network.
 * Tests inject their own renderer through `buildPipgmServer({ frameRenderer })`.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface FrameRenderRequest {
  html: string;
  width: number;
  height: number;
  transparent: boolean;
}

export type PipgmFrameRenderer = (request: FrameRenderRequest) => Promise<Buffer>;

/** The renderer cannot run here (no browser binary, for example). The route answers 503. */
export class FrameRendererUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameRendererUnavailableError";
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPng(bytes: Buffer): boolean {
  return bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

export interface ChromiumScreenshotInput {
  htmlPath: string;
  outPath: string;
  profileDir: string;
  width: number;
  height: number;
  transparent: boolean;
  noSandbox: boolean;
}

/** The Chromium command line for one screenshot. Pure, so the arguments are testable. */
export function chromiumScreenshotArgs(input: ChromiumScreenshotInput): string[] {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--mute-audio",
    "--force-device-scale-factor=1",
    `--user-data-dir=${input.profileDir}`,
    `--window-size=${input.width},${input.height}`,
    `--screenshot=${input.outPath}`
  ];
  if (input.transparent) args.push("--default-background-color=00000000");
  if (input.noSandbox) args.push("--no-sandbox");
  args.push(pathToFileURL(input.htmlPath).href);
  return args;
}

export interface ChromiumFrameRendererOptions {
  /** Browser binary. Defaults to PIPGM_CHROMIUM, then `chromium`. */
  binary?: string;
  /** Adds --no-sandbox (needed only when running as root). Defaults to PIPGM_CHROMIUM_NO_SANDBOX=1. */
  noSandbox?: boolean;
  timeoutMs?: number;
}

export function createChromiumFrameRenderer(options: ChromiumFrameRendererOptions = {}): PipgmFrameRenderer {
  const binary = options.binary ?? (process.env.PIPGM_CHROMIUM?.trim() || "chromium");
  const noSandbox = options.noSandbox ?? process.env.PIPGM_CHROMIUM_NO_SANDBOX === "1";
  const timeoutMs = options.timeoutMs ?? 30_000;

  return async ({ html, width, height, transparent }) => {
    const dir = await mkdtemp(join(tmpdir(), "piprogram-frame-"));
    try {
      const htmlPath = join(dir, "stage.html");
      const outPath = join(dir, "frame.png");
      await writeFile(htmlPath, html, "utf8");
      const args = chromiumScreenshotArgs({
        htmlPath,
        outPath,
        profileDir: join(dir, "profile"),
        width,
        height,
        transparent,
        noSandbox
      });
      await runBrowser(binary, args, timeoutMs);
      const png = await readFile(outPath).catch(() => null);
      if (!png || !isPng(png)) throw new Error("The browser did not write a PNG screenshot");
      return png;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

function runBrowser(binary: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const isBatchOnWindows = process.platform === "win32" && (binary.toLowerCase().endsWith(".cmd") || binary.toLowerCase().endsWith(".bat"));
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"], shell: isBatchOnWindows });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        error.code === "ENOENT"
          ? new FrameRendererUnavailableError(`Browser not found for the frame route: ${binary} (set PIPGM_CHROMIUM)`)
          : error
      );
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error(`Browser exited with ${signal ?? code}: ${stderr.trim() || "no output"}`));
    });
  });
}
