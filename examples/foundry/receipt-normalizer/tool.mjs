/**
 * DRAFT candidate for receipt-normalizer/v1.
 * Not imported, executed, independently evaluated, activated or live-verified.
 * Proposed module ABI only; a qualified JS adapter/transport does not yet exist.
 * No imports, I/O, ambient identity, clock, randomness or dependency installation.
 */

const STATUSES = Object.freeze(["succeeded", "failed", "cancelled", "unknown", "unverified"]);
const MAX_RECORDS = 1_000;
const MAX_RECORD_TOKENS = 1_000_000_000;
const MAX_NOTE_SCALARS = 4_096;
const MAX_INPUT_BYTES = 1_048_576;
const MAX_RESULT_BYTES = 1_048_576;

class ReceiptValidationError extends Error {
  constructor() {
    super("SCHEMA_INVALID");
    this.name = "ReceiptValidationError";
    this.code = "SCHEMA_INVALID";
  }
}

function invalid() {
  throw new ReceiptValidationError();
}

/** Count Unicode scalar UTF-8 bytes without reading a file or host API. */
function requireUtf8Within(text, maximum) {
  let bytes = 0;
  for (const scalar of text) {
    const point = scalar.codePointAt(0);
    if (point >= 0xd800 && point <= 0xdfff) invalid();
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > maximum) invalid();
  }
}

/**
 * Parse JSON data while rejecting duplicate decoded property names. JSON.parse
 * is used only on one string token to decode JSON escapes, never as code.
 * A valid receipt envelope needs depth 3 and at most 4,002 value nodes.
 */
function parseReceiptJson(text) {
  let position = 0;
  let nodes = 0;
  const whitespace = () => {
    while (position < text.length && /[\t\n\r ]/.test(text[position])) position++;
  };
  const string = () => {
    const start = position++;
    while (position < text.length) {
      const character = text[position++];
      if (character === "\\") position++;
      else if (character === '"') {
        try {
          return JSON.parse(text.slice(start, position));
        } catch {
          invalid();
        }
      }
    }
    invalid();
  };
  const value = (depth) => {
    if (depth > 8 || ++nodes > 10_000) invalid();
    whitespace();
    const character = text[position];
    if (character === '"') return string();
    if (character === "{") {
      position++;
      whitespace();
      const object = Object.create(null);
      const names = new Set();
      if (text[position] === "}") {
        position++;
        return object;
      }
      while (position < text.length) {
        whitespace();
        if (text[position] !== '"') invalid();
        const name = string();
        if (names.has(name)) invalid();
        names.add(name);
        whitespace();
        if (text[position++] !== ":") invalid();
        object[name] = value(depth + 1);
        whitespace();
        const separator = text[position++];
        if (separator === "}") return object;
        if (separator !== ",") invalid();
      }
      invalid();
    }
    if (character === "[") {
      position++;
      whitespace();
      const array = [];
      if (text[position] === "]") {
        position++;
        return array;
      }
      while (position < text.length) {
        array.push(value(depth + 1));
        whitespace();
        const separator = text[position++];
        if (separator === "]") return array;
        if (separator !== ",") invalid();
      }
      invalid();
    }
    for (const [literal, parsed] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ]) {
      if (text.startsWith(literal, position)) {
        position += literal.length;
        return parsed;
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(position));
    if (!number) invalid();
    position += number[0].length;
    const parsed = Number(number[0]);
    if (!Number.isFinite(parsed)) invalid();
    return parsed;
  };
  const parsed = value(0);
  whitespace();
  if (position !== text.length) invalid();
  return parsed;
}

function exactRecord(value, required, optional = []) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== null)
    invalid();
  const keys = Object.keys(value);
  if (
    keys.length < required.length ||
    keys.length > required.length + optional.length ||
    !required.every((key) => Object.hasOwn(value, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  )
    invalid();
}

function validateNote(note) {
  if (typeof note !== "string" || note.length > MAX_NOTE_SCALARS * 2) invalid();
  let scalars = 0;
  for (const scalar of note) {
    const point = scalar.codePointAt(0);
    if ((point >= 0xd800 && point <= 0xdfff) || ++scalars > MAX_NOTE_SCALARS) invalid();
  }
}

/**
 * PROPOSED ABI, not an installed Foundry runtime protocol:
 * canonical input JSON string -> one output JSON string, or SCHEMA_INVALID.
 * The trusted runner must bind input/package digests, enforce resource limits,
 * validate output independently and produce its own execution receipt.
 */
export function normalizeReceiptJson(inputJson) {
  if (typeof inputJson !== "string") invalid();
  requireUtf8Within(inputJson, MAX_INPUT_BYTES);
  const input = parseReceiptJson(inputJson);
  exactRecord(input, ["records"]);
  if (!Array.isArray(input.records) || input.records.length > MAX_RECORDS) invalid();

  const counts = { succeeded: 0, failed: 0, cancelled: 0, unknown: 0, unverified: 0 };
  let tokens = 0;
  for (const record of input.records) {
    exactRecord(record, ["status", "tokens"], ["note"]);
    if (
      !STATUSES.includes(record.status) ||
      typeof record.tokens !== "number" ||
      !Number.isSafeInteger(record.tokens) ||
      record.tokens < 0 ||
      record.tokens > MAX_RECORD_TOKENS
    )
      invalid();
    if (Object.hasOwn(record, "note")) validateNote(record.note);
    // Notes are only bounded strings. They never select code, targets or status.
    counts[record.status]++;
    tokens += record.tokens;
  }

  const output = JSON.stringify({ total: input.records.length, counts, tokens });
  requireUtf8Within(output, MAX_RESULT_BYTES);
  return output;
}
