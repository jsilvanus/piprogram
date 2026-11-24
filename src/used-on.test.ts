import assert from "node:assert/strict";
import test from "node:test";
import { addUsedOn, parseUsedOnDate, removeUsedOn, UsedOnError } from "./used-on.js";

test("parses real days and refuses anything else", () => {
  assert.equal(parseUsedOnDate(" 2026-11-08 "), "2026-11-08");
  assert.throws(() => parseUsedOnDate("2026-02-30"), UsedOnError);
  assert.throws(() => parseUsedOnDate("2026-11-08T10"), UsedOnError);
  assert.throws(() => parseUsedOnDate(5), UsedOnError);
});

test("adds a date once, keeps the list sorted, removes a date", () => {
  let list = addUsedOn(undefined, "2026-11-29");
  list = addUsedOn(list, "2026-11-08");
  list = addUsedOn(list, "2026-11-29");
  assert.deepEqual(list, ["2026-11-08", "2026-11-29"]);
  assert.deepEqual(removeUsedOn(list, "2026-11-08"), ["2026-11-29"]);
  assert.deepEqual(removeUsedOn(undefined, "2026-11-08"), []);
});
