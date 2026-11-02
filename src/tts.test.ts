import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiperEngine, createTtsEngineFromEnv, readWavInfo } from "./tts.js";

// A stand-in for the piper binary: records the text it got on stdin next to the output and writes a 1 s WAV.
const FAKE_PIPER = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const out = args[args.indexOf("--output_file") + 1];
const model = args[args.indexOf("--model") + 1];
let text = "";
process.stdin.on("data", (c) => (text += c));
process.stdin.on("end", () => {
  if (text.includes("FAIL")) { console.error("boom"); process.exit(3); }
  const rate = 8000, bytes = rate * 2;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + bytes, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(bytes, 40);
  fs.writeFileSync(out, Buffer.concat([h, Buffer.alloc(bytes)]));
  fs.writeFileSync(out + ".meta", JSON.stringify({ text, model }));
});
`;

test("the Piper engine runs the binary with the voice model and reads back the WAV", async () => {
  const dir = await mkdtemp(join(tmpdir(), "piprogram-fakepiper-"));
  try {
    const binary = join(dir, "piper");
    await writeFile(binary, FAKE_PIPER);
    await chmod(binary, 0o755);
    const engine = createPiperEngine({ binary, modelDir: "/models", defaultVoice: "fi_FI-harri-medium", timeoutMs: 10_000 });
    const wav = await engine.synthesize("Hyvää\n huomenta", {});
    assert.equal(readWavInfo(wav)?.durationMs, 1000);
    await assert.rejects(engine.synthesize("please FAIL", {}), /piper exited with 3: boom/);
    await assert.rejects(engine.synthesize("hi", { voice: "../x" }), /invalid voice/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TTS is off without PIPGM_TTS_MODEL_DIR and readWavInfo refuses non-WAV bytes", () => {
  assert.equal(createTtsEngineFromEnv({}), undefined);
  assert.ok(createTtsEngineFromEnv({ PIPGM_TTS_MODEL_DIR: "/models" }));
  assert.equal(readWavInfo(Buffer.from("definitely not a wav file, long enough to pass the length check....")), null);
});
