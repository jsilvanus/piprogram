import assert from "node:assert/strict";
import test from "node:test";
import { formatHymnNumber, hymnalPrefixOf, parseHymnals, sameHymnNumber, splitHymnNumber } from "./hymnals.js";

test("a number without prefix is Virsikirja, other prefixes are their own book", () => {
  assert.equal(hymnalPrefixOf("123"), "VK");
  assert.equal(hymnalPrefixOf("vk 123"), "VK");
  assert.equal(hymnalPrefixOf("LV12"), "LV");
  assert.equal(hymnalPrefixOf(""), "VK");
  assert.deepEqual(splitHymnNumber("LV-12"), { prefix: "LV", number: "12", explicit: true });
  assert.equal(splitHymnNumber("psalmi"), null);
});

test("numbers are stored in one form and compared by book and number", () => {
  assert.equal(formatHymnNumber("lv12"), "LV 12");
  assert.equal(formatHymnNumber(" 123 "), "123");
  assert.equal(formatHymnNumber("Virsi"), "Virsi");
  assert.ok(sameHymnNumber("123", "VK 123"));
  assert.ok(!sameHymnNumber("12", "LV 12"));
});

test("the hymnal list is configurable and always has the Virsikirja", () => {
  assert.deepEqual(parseHymnals(undefined).map((h) => h.prefix), ["VK", "LV"]);
  assert.deepEqual(parseHymnals("LV=Lasten virsi, XY=Oma").map((h) => h.prefix), ["VK", "LV", "XY"]);
  assert.deepEqual(parseHymnals('[{"prefix":"nv","name":"Nuorten"}]').map((h) => h.prefix), ["VK", "NV"]);
  assert.deepEqual(parseHymnals("1=bad").map((h) => h.prefix), ["VK", "LV"]);
});
