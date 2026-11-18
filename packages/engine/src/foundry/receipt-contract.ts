/** Strict data contract for the first offline capability. This module never executes a candidate. */
export const RECEIPT_CONTRACT_ID = "receipt-normalizer/v1";

const STATUSES = ["succeeded", "failed", "cancelled", "unknown", "unverified"] as const;
const MAX_RECORDS = 1000;
const MAX_RECORD_TOKENS = 1000000000;
const MAX_INPUT_BYTES = 1048576;
const MAX_NOTE_SCALARS = 4096;

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Schemas describe wire data; the validators below also check invariants and serialized byte limits. */
export const RECEIPT_INPUT_SCHEMA: Record<string, unknown> = freeze({
  type: "object",
  additionalProperties: false,
  required: ["records"],
  properties: {
    records: {
      type: "array",
      maxItems: MAX_RECORDS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["status", "tokens"],
        properties: {
          status: { type: "string", enum: STATUSES },
          tokens: { type: "integer", minimum: 0, maximum: MAX_RECORD_TOKENS },
          note: { type: "string", maxLength: MAX_NOTE_SCALARS },
        },
      },
    },
  },
});

export const RECEIPT_OUTPUT_SCHEMA: Record<string, unknown> = freeze({
  type: "object",
  additionalProperties: false,
  required: ["total", "counts", "tokens"],
  properties: {
    total: { type: "integer", minimum: 0, maximum: MAX_RECORDS },
    counts: {
      type: "object",
      additionalProperties: false,
      required: STATUSES,
      properties: Object.fromEntries(
        STATUSES.map((status) => [status, { type: "integer", minimum: 0, maximum: MAX_RECORDS }]),
      ),
    },
    tokens: { type: "integer", minimum: 0, maximum: MAX_RECORDS * MAX_RECORD_TOKENS },
  },
});

function integer(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

/** Read only own enumerable data properties: no getters, symbols, hidden or inherited fields. */
function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length < required.length || keys.length > required.length + optional.length) return null;
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key))) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
    result[key] = descriptor.value;
  }
  return required.every((key) => Object.hasOwn(result, key)) ? result : null;
}

function records(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!integer(length, MAX_RECORDS) || Reflect.ownKeys(value).length !== length + 1) return null;
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
    result.push(descriptor.value);
  }
  return result;
}

function validNote(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_NOTE_SCALARS * 2) return false;
  let count = 0;
  for (const scalar of value) {
    const point = scalar.codePointAt(0)!;
    if ((point >= 0xd800 && point <= 0xdfff) || ++count > MAX_NOTE_SCALARS) return false;
  }
  return true;
}

export function validateReceiptInput(input: unknown): boolean {
  try {
    const envelope = record(input, ["records"]);
    if (!envelope) return false;
    const values = records(envelope.records);
    if (!values) return false;
    const plain: Record<string, unknown>[] = [];
    for (const value of values) {
      const item = record(value, ["status", "tokens"], ["note"]);
      if (!item || !STATUSES.some((status) => status === item.status) || !integer(item.tokens, MAX_RECORD_TOKENS))
        return false;
      if (Object.hasOwn(item, "note") && !validNote(item.note)) return false;
      plain.push(item);
    }
    return Buffer.byteLength(JSON.stringify({ records: plain }), "utf8") <= MAX_INPUT_BYTES;
  } catch {
    return false;
  }
}

/** Validates output shape and internal consistency; an independent evaluator must check it against its input. */
export function validateReceiptOutput(output: unknown): boolean {
  try {
    const value = record(output, ["total", "counts", "tokens"]);
    if (!value || !integer(value.total, MAX_RECORDS) || !integer(value.tokens, value.total * MAX_RECORD_TOKENS))
      return false;
    const counts = record(value.counts, STATUSES);
    if (!counts) return false;
    let total = 0;
    for (const status of STATUSES) {
      const count = counts[status];
      if (!integer(count, MAX_RECORDS)) return false;
      total += count;
    }
    return total === value.total;
  } catch {
    return false;
  }
}

/** Conservative routing hint only. It grants neither a scope nor permission to execute. */
export function receiptAppliesTo(text: string): boolean {
  if (typeof text !== "string" || text.length > 8192) return false;
  const objective = text.normalize("NFKC").trim().toLowerCase();
  if (
    !objective ||
    /\b(?:invoice|expense|tax|sale|purchase|payment|refund|billing)s?\b|發票|发票|報銷|报销|帳單|账单|付款|稅|税/u.test(
      objective,
    )
  )
    return false;
  if (
    /\b(?:do not|don't|never)\s+(?:use|run|invoke|apply|normalize|normalise|aggregate)\b|不要(?:使用|運行|运行|整理|彙總|汇总)/u.test(
      objective,
    )
  )
    return false;
  if (objective === RECEIPT_CONTRACT_ID) return true;
  const action =
    /\b(?:use|invoke|run|apply|normalize|normalise|aggregate|summarize|summarise)\b|使用|整理|正規化|规范化|標準化|标准化|彙總|匯總|汇总/u.test(
      objective,
    );
  if (!action) return false;
  if (/(?:^|[^a-z0-9_-])receipt-normalizer\/v1(?:$|[^a-z0-9_/-])/u.test(objective)) return true;
  return (
    /\b(?:synthetic|simulated)\b|合成|模擬|模拟/u.test(objective) &&
    /\b(?:task|run)\b|任務|任务|運行|运行/u.test(objective) &&
    /\breceipts?\b|收據|收据/u.test(objective)
  );
}
