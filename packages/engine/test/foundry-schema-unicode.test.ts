import { expect, test } from "bun:test";
import { RECEIPT_INPUT_SCHEMA } from "../src/foundry/receipt-contract";
import { validateJson } from "../src/tools/json-schema";

test("schema string limits count Unicode code points, including astral characters", () => {
  expect(validateJson({ type: "string", minLength: 1, maxLength: 1 }, "🎹")).toEqual([]);
  expect(validateJson({ type: "string", minLength: 2 }, "🎹")).toEqual(["input: too short (at least 2 characters)"]);
  expect(validateJson({ type: "string", maxLength: 1 }, "🎹a")).toEqual(["input: too long (at most 1 characters)"]);
  expect(validateJson({ type: "string", minLength: 2, maxLength: 2 }, "合成")).toEqual([]);
});

test("a full 4096-scalar receipt note passes the native gateway schema and the next scalar fails", () => {
  const record = { status: "unknown", tokens: 0, note: "🎹".repeat(4096) };
  expect(validateJson(RECEIPT_INPUT_SCHEMA, { records: [record] })).toEqual([]);
  expect(validateJson(RECEIPT_INPUT_SCHEMA, { records: [{ ...record, note: record.note + "a" }] })).toEqual([
    "input.records[0].note: too long (at most 4096 characters)",
  ]);
});

test("combining sequences remain distinct code points rather than changing existing text semantics", () => {
  expect(validateJson({ type: "string", maxLength: 1 }, "e\u0301")).toEqual(["input: too long (at most 1 characters)"]);
  expect(validateJson({ type: "string", minLength: 1 }, "")).toEqual(["input: too short (at least 1 characters)"]);
  expect(validateJson({ type: "string", maxLength: 1 }, "a")).toEqual([]);
});
