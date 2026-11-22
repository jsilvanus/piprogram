/**
 * Renders the stage page of one pipeline to a PNG, so a client can read the current slide
 * as a still (pimatrix's slide composite). The renderer is a headless Chromium
 * (`PIPGM_CHROMIUM`, default `chromium`) kept running between renders and driven over the
 * DevTools protocol (`./cdp.ts`, the WebSocket built into Node; no browser library is linked in).
 * It is started on the first render, renders one page per request (concurrency
 * `PIPGM_RENDER_CONCURRENCY`, default 1), shuts down when idle (`PIPGM_CHROMIUM_IDLE_MS`) and is
 * recycled after `PIPGM_CHROMIUM_MAX_RENDERS` renders or when it dies.
 * Tests inject their own renderer through `buildPipgmServer({ frameRenderer })`.
 */

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CdpClient, CdpDisconnectedError, type CdpSocketFactory } from "./cdp.js";

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

/** The Chromium command line of the long-lived browser. Pure, so the arguments are testable. */
export function chromiumLaunchArgs(input: { profileDir: string; noSandbox: boolean }): string[] {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--remote-debugging-port=0",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${input.profileDir}`
  ];
  if (input.noSandbox) args.push("--no-sandbox");
  args.push("about:blank");
  return args;
}

/** The part of a child process the renderer uses, so tests can fake the browser. */
export interface BrowserProcess {
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  kill(signal?: NodeJS.Signals): unknown;
  once(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  unref?(): void;
}

export type BrowserSpawn = (binary: string, args: string[]) => BrowserProcess;

export interface ChromiumFrameRendererOptions {
  /** Browser binary. Defaults to PIPGM_CHROMIUM, then `chromium`. */
  binary?: string;
  /** Adds --no-sandbox (needed only when running as root). Defaults to PIPGM_CHROMIUM_NO_SANDBOX=1. */
  noSandbox?: boolean;
  /** Per render, and for the browser to start. */
  timeoutMs?: number;
  /** Renders at the same time. Defaults to PIPGM_RENDER_CONCURRENCY, then 1. */
  concurrency?: number;
  /** The browser is shut down after this long without a render. Defaults to PIPGM_CHROMIUM_IDLE_MS, then 60000. 0 = never. */
  idleMs?: number;
  /** The browser is replaced after this many renders. Defaults to PIPGM_CHROMIUM_MAX_RENDERS, then 200. 0 = never. */
  maxRenders?: number;
  /** Test hooks. */
  spawn?: BrowserSpawn;
  socketFactory?: CdpSocketFactory;
}

export interface ChromiumFrameRenderer extends PipgmFrameRenderer {
  /** Stops the browser now (the next render starts a new one). */
  close(): Promise<void>;
}

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min ? value : fallback;
}

interface Browser {
  child: BrowserProcess;
  client: CdpClient;
  dir: string;
  renders: number;
  active: number;
  retiring: boolean;
  dead: boolean;
}

// Never leave a browser or its profile behind when the service exits (one handler for all renderers).
const liveSets = new Set<Set<Browser>>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const set of liveSets) {
      for (const browser of set) {
        try {
          browser.child.kill("SIGKILL");
        } catch {
          // already gone
        }
        try {
          rmSync(browser.dir, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
    }
  });
}

function defaultSpawn(binary: string, args: string[]): BrowserProcess {
  const isBatchOnWindows = process.platform === "win32" && (binary.toLowerCase().endsWith(".cmd") || binary.toLowerCase().endsWith(".bat"));
  return spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"], shell: isBatchOnWindows });
}

export function createChromiumFrameRenderer(options: ChromiumFrameRendererOptions = {}): ChromiumFrameRenderer {
  const binary = options.binary ?? (process.env.PIPGM_CHROMIUM?.trim() || "chromium");
  const noSandbox = options.noSandbox ?? process.env.PIPGM_CHROMIUM_NO_SANDBOX === "1";
  const timeoutMs = options.timeoutMs ?? 30_000;
  const concurrency = Math.max(1, options.concurrency ?? envInt("PIPGM_RENDER_CONCURRENCY", 1, 1));
  const idleMs = options.idleMs ?? envInt("PIPGM_CHROMIUM_IDLE_MS", 60_000, 0);
  const maxRenders = options.maxRenders ?? envInt("PIPGM_CHROMIUM_MAX_RENDERS", 200, 0);
  const spawnBrowser = options.spawn ?? defaultSpawn;

  let current: Browser | null = null;
  let starting: Promise<Browser> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const live = new Set<Browser>();
  liveSets.add(live);
  installExitHook();

  // Render queue: at most `concurrency` renders run at once, the rest wait in order.
  let running = 0;
  const waiting: Array<() => void> = [];
  const acquire = (): Promise<void> => {
    if (running < concurrency) {
      running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  };

  const clearIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };

  const stopBrowser = async (browser: Browser): Promise<void> => {
    if (current === browser) current = null;
    live.delete(browser);
    browser.dead = true;
    browser.client.close();
    try {
      browser.child.kill("SIGKILL");
    } catch {
      // already gone
    }
    await rm(browser.dir, { recursive: true, force: true });
  };

  const startBrowser = async (): Promise<Browser> => {
    const dir = await mkdtemp(join(tmpdir(), "piprogram-chromium-"));
    let child: BrowserProcess;
    try {
      child = spawnBrowser(binary, chromiumLaunchArgs({ profileDir: join(dir, "profile"), noSandbox }));
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    child.unref?.();
    let stderr = "";
    let endpoint: string;
    try {
      endpoint = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Browser did not start within ${timeoutMs} ms: ${stderr.trim() || "no output"}`)), timeoutMs);
        const fail = (error: Error): void => {
          clearTimeout(timer);
          reject(error);
        };
        child.stderr?.on("data", (chunk) => {
          stderr = (stderr + chunk.toString()).slice(-2000);
          const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
          if (match?.[1]) {
            clearTimeout(timer);
            resolve(match[1]);
          }
        });
        child.once("error", (error) =>
          fail(
            error.code === "ENOENT"
              ? new FrameRendererUnavailableError(`Browser not found for the frame route: ${binary} (set PIPGM_CHROMIUM)`)
              : error
          )
        );
        child.once("exit", (code, signal) => fail(new Error(`Browser exited with ${signal ?? code}: ${stderr.trim() || "no output"}`)));
      });
    } catch (error) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    let client: CdpClient;
    try {
      client = await CdpClient.connect(endpoint, options.socketFactory);
    } catch (error) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    const browser: Browser = { child, client, dir, renders: 0, active: 0, retiring: false, dead: false };
    live.add(browser);
    // A crash or disconnect retires this browser; the next render starts a new one.
    client.onClose(() => void stopBrowser(browser));
    child.once("exit", () => void stopBrowser(browser));
    return browser;
  };

  const getBrowser = async (): Promise<Browser> => {
    if (current && !current.dead && !current.retiring) return current;
    if (!starting) {
      starting = startBrowser()
        .then((browser) => {
          current = browser;
          return browser;
        })
        .finally(() => {
          starting = null;
        });
    }
    return starting;
  };

  const renderOnce = async (request: FrameRenderRequest): Promise<Buffer> => {
    const browser = await getBrowser();
    browser.active += 1;
    browser.renders += 1;
    if (maxRenders > 0 && browser.renders >= maxRenders) browser.retiring = true;
    const { client } = browser;
    const htmlPath = join(browser.dir, `stage-${browser.renders}-${Math.random().toString(36).slice(2)}.html`);
    let targetId: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    try {
      const work = (async (): Promise<Buffer> => {
        await writeFile(htmlPath, request.html, "utf8");
        const created = await client.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
        targetId = created.targetId;
        const attached = await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
        const sessionId = attached.sessionId;
        await client.send("Page.enable", {}, sessionId);
        await client.send(
          "Emulation.setDeviceMetricsOverride",
          { width: request.width, height: request.height, deviceScaleFactor: 1, mobile: false },
          sessionId
        );
        // Opaque frames get an explicit white page background (a bare page screenshots as alpha 0 otherwise).
        await client.send(
          "Emulation.setDefaultBackgroundColorOverride",
          { color: request.transparent ? { r: 0, g: 0, b: 0, a: 0 } : { r: 255, g: 255, b: 255, a: 1 } },
          sessionId
        );
        const loaded = client.waitForEvent("Page.loadEventFired", sessionId);
        loaded.catch(() => undefined);
        const nav = await client.send<{ errorText?: string }>("Page.navigate", { url: pathToFileURL(htmlPath).href }, sessionId);
        if (nav.errorText) throw new Error(`The browser could not load the page: ${nav.errorText}`);
        await loaded;
        const shot = await client.send<{ data: string }>("Page.captureScreenshot", { format: "png", fromSurface: true }, sessionId);
        const png = Buffer.from(shot.data ?? "", "base64");
        if (!isPng(png)) throw new Error("The browser did not return a PNG screenshot");
        return png;
      })();
      work.catch(() => undefined);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`The browser did not finish the frame within ${timeoutMs} ms`));
        }, timeoutMs);
      });
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        // A stuck page cannot be trusted; replace the whole browser.
        browser.retiring = true;
        void stopBrowser(browser);
      } else if (targetId && !browser.dead) {
        await client.send("Target.closeTarget", { targetId }).catch(() => undefined);
      }
      await rm(htmlPath, { force: true }).catch(() => undefined);
      browser.active -= 1;
      if (browser.retiring && browser.active === 0) void stopBrowser(browser);
    }
  };

  const render: PipgmFrameRenderer = async (request) => {
    clearIdle();
    await acquire();
    try {
      clearIdle();
      try {
        return await renderOnce(request);
      } catch (error) {
        // The browser died under us (crash, killed): start a fresh one and try once more.
        if (error instanceof CdpDisconnectedError) return await renderOnce(request);
        throw error;
      }
    } finally {
      release();
      if (running === 0 && idleMs > 0) {
        clearIdle();
        idleTimer = setTimeout(() => {
          idleTimer = null;
          if (running === 0 && current) void stopBrowser(current);
        }, idleMs);
        idleTimer.unref();
      }
    }
  };

  const close = async (): Promise<void> => {
    clearIdle();
    await Promise.all([...live].map((browser) => stopBrowser(browser)));
  };

  return Object.assign(render, { close });
}
