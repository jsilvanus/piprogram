#!/usr/bin/env node
import { runCli } from "./cli.js";

const baseUrl = (process.env.PIPGM_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const apiKey = process.env.PIPGM_API_KEY?.trim() || undefined;

runCli(process.argv.slice(2), {
  fetch: (url, init) => fetch(url, init),
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  baseUrl,
  apiKey
}).then((code) => {
  process.exitCode = code;
});
