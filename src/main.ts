import { buildPipgmServer } from "./server.js";

/** Starts the PiPGM HTTP API. Reads PIPGM_PORT (default 3100), PIPGM_HOST (default 127.0.0.1) and PIPGM_API_KEY. */
async function main(): Promise<void> {
  const port = Number(process.env.PIPGM_PORT ?? 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PIPGM_PORT must be a port number");
  const host = process.env.PIPGM_HOST?.trim() || "127.0.0.1";
  const apiKey = process.env.PIPGM_API_KEY?.trim() || undefined;
  if (!apiKey && host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("PIPGM_API_KEY is required when PIPGM_HOST is not loopback");
  }
  const app = buildPipgmServer({ apiKey, logger: true });
  const shutdown = (): void => {
    void app.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await app.listen({ host, port });
}

main().catch((error: unknown) => {
  console.error("piprogram failed to start:", error);
  process.exitCode = 1;
});
