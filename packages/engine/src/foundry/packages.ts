import { createHash } from "node:crypto";
import { z } from "zod";

/** Inert package limits; neither these values nor a manifest qualify an execution environment. */
export const PACKAGE_LIMITS = {
  manifestBytes: 64 * 1024,
  files: 100,
  fileBytes: 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
  pathBytes: 512,
  jsonDepth: 32,
} as const;

export class FoundryPackageError extends Error {
  constructor(
    readonly code: "SCHEMA_INVALID" | "STALE_VERSION",
    message: string,
  ) {
    super(message);
    this.name = "FoundryPackageError";
  }
}

const invalid = (message: string): never => {
  throw new FoundryPackageError("SCHEMA_INVALID", message);
};
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const shortText = (max: number) => z.string().min(1).max(max);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const exactVersion = z
  .string()
  .max(256)
  .regex(
    /^(?:(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?|[a-f0-9]{40}|[a-f0-9]{64})$/,
  );
const runtime = z
  .object({
    profile: z.literal("pure-offline-v1"),
    wallTimeMs: z.number().int().min(1).max(10000),
    memoryMiB: z.number().int().min(1).max(256),
    scratchMiB: z.number().int().min(1).max(32),
    processes: z.number().int().min(1).max(32),
    logBytesPerStream: z.number().int().min(1).max(65536),
    inputBytes: z.number().int().min(1).max(1048576),
    resultBytes: z.number().int().min(1).max(1048576),
  })
  .strict();
const manifestSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
    kind: z.enum(["instruction_skill", "pure_tool", "connector_wrapper", "harness_patch"]),
    description: shortText(1024),
    applicability: z
      .object({
        useFor: z.array(shortText(500)).min(1).max(20),
        doNotUseFor: z.array(shortText(500)).min(1).max(20),
      })
      .strict(),
    scopeRequest: z
      .object({
        level: z.enum(["task", "project", "team", "organization"]),
        purpose: shortText(500),
      })
      .strict(),
    effects: z
      .object({
        network: z.enum(["none", "broker_allowlist"]),
        secrets: z.enum(["none", "broker_only"]),
        filesystem: z.enum(["none", "readonly_inputs_temp_output"]),
        externalActions: z
          .array(shortText(256))
          .max(30)
          .refine((xs) => new Set(xs).size === xs.length),
        nestedCapabilities: z.array(z.object({ nativeRef: shortText(256), digest: sha }).strict()).max(30),
      })
      .strict(),
    contracts: z
      .object({
        input: z.record(z.string(), z.unknown()),
        output: z.record(z.string(), z.unknown()),
      })
      .strict(),
    dependencies: z
      .array(
        z
          .object({
            name: shortText(256),
            version: exactVersion,
            integrity: sha,
            licenseDisposition: z.enum(["reviewed_allowed", "review_required"]),
          })
          .strict(),
      )
      .max(30),
    runtimeRequest: runtime.nullable(),
    provenance: z
      .object({
        origin: z.enum(["generated", "adapted", "imported"]),
        sourceRefs: z.array(shortText(2048)).min(1).max(30),
        licenseDisposition: z.enum(["original_internal", "reviewed_allowed", "review_required"]),
        containsPrivateData: z.boolean(),
      })
      .strict(),
    developmentTests: z.array(shortText(256)).min(1).max(100),
    rollback: z
      .object({
        onFailure: z.literal("quarantine_and_revalidate_previous"),
        previousNativeVersion: z.string().max(256).nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (
      m.kind === "pure_tool" &&
      (!m.runtimeRequest ||
        m.effects.network !== "none" ||
        m.effects.secrets !== "none" ||
        m.effects.externalActions.length ||
        m.effects.nestedCapabilities.length)
    )
      ctx.addIssue({
        code: "custom",
        message: "A pure tool requires a bounded offline runtime and no external effects.",
      });
  });

export type CapabilityManifest = z.infer<typeof manifestSchema>;
export interface PackageFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  /** A trusted archive/file reader supplies actual entry metadata; this function never follows a path. */
  readonly kind: "file" | "directory" | "symlink" | "hardlink" | "device";
  readonly linkCount?: number;
}
export interface FrozenPackage {
  readonly packageVersion: "foundry-package/1";
  readonly manifest: Readonly<CapabilityManifest>;
  readonly manifestJson: string;
  readonly files: readonly { readonly path: string; readonly base64: string }[];
  readonly inventory: readonly { readonly path: string; readonly sha256: string; readonly bytes: number }[];
  readonly digest: string;
  readonly totalBytes: number;
}

/** Canonical JSON accepts data only: no getters, toJSON, undefined, cycles, nonfinite numbers or class instances. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  let nodes = 0;
  const encode = (v: unknown, depth: number): string => {
    if (++nodes > 100000 || depth > 64) return invalid("JSON structure exceeds package limits.");
    if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number") return Number.isFinite(v) ? JSON.stringify(v) : invalid("JSON numbers must be finite.");
    if (typeof v !== "object") return invalid("Only JSON data may be packaged.");
    if (ancestors.has(v)) return invalid("Cyclic JSON cannot be packaged.");
    const array = Array.isArray(v);
    const proto = Object.getPrototypeOf(v);
    if ((!array && proto !== null && proto !== Object.prototype) || (array && proto !== Array.prototype))
      return invalid("Only plain JSON containers may be packaged.");
    const descriptors = Object.getOwnPropertyDescriptors(v);
    if (
      Reflect.ownKeys(v).some((k) => typeof k !== "string") ||
      Object.values(descriptors).some((d) => !("value" in d) || (!d.enumerable && !(array && d === descriptors.length)))
    )
      return invalid("JSON accessors and hidden properties cannot be packaged.");
    ancestors.add(v);
    let result: string;
    if (array) {
      const length = (v as unknown[]).length;
      if (Object.keys(descriptors).length !== length + 1)
        return invalid("Sparse or extended arrays cannot be packaged.");
      const values: string[] = [];
      for (let i = 0; i < length; i++) {
        const item = descriptors[String(i)];
        if (!item) return invalid("Sparse arrays cannot be packaged.");
        values.push(encode(item.value, depth + 1));
      }
      result = "[" + values.join(",") + "]";
    } else {
      result =
        "{" +
        Object.keys(descriptors)
          .sort()
          .map((key) => JSON.stringify(key) + ":" + encode(descriptors[key]?.value, depth + 1))
          .join(",") +
        "}";
    }
    ancestors.delete(v);
    return result;
  };
  return encode(value, 0);
}

/** Parse before JSON.parse can discard duplicate keys. Escaped names compare as their decoded strings. */
function parseManifestJson(raw: string): unknown {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > PACKAGE_LIMITS.manifestBytes)
    return invalid("Manifest exceeds the byte limit.");
  let at = 0;
  let nodes = 0;
  const white = () => {
    while (/[\t\n\r ]/.test(raw[at] ?? "") && at < raw.length) at++;
  };
  const string = (): string => {
    const start = at++;
    while (at < raw.length) {
      const c = raw[at++];
      if (c === "\\") at++;
      else if (c === '"') {
        try {
          return JSON.parse(raw.slice(start, at)) as string;
        } catch {
          return invalid("Invalid JSON string.");
        }
      }
    }
    return invalid("Unterminated JSON string.");
  };
  const value = (depth: number): unknown => {
    if (++nodes > 20000 || depth > PACKAGE_LIMITS.jsonDepth) return invalid("Manifest JSON structure exceeds limits.");
    white();
    const c = raw[at];
    if (c === '"') return string();
    if (c === "{") {
      at++;
      white();
      const object: Record<string, unknown> = Object.create(null);
      const keys = new Set<string>();
      if (raw[at] === "}") {
        at++;
        return object;
      }
      while (at < raw.length) {
        white();
        if (raw[at] !== '"') return invalid("Expected a JSON property.");
        const key = string();
        if (keys.has(key)) return invalid("Duplicate JSON keys are not allowed.");
        keys.add(key);
        white();
        if (raw[at++] !== ":") return invalid("Expected a JSON colon.");
        object[key] = value(depth + 1);
        white();
        const separator = raw[at++];
        if (separator === "}") return object;
        if (separator !== ",") return invalid("Expected a JSON object separator.");
      }
      return invalid("Unterminated JSON object.");
    }
    if (c === "[") {
      at++;
      white();
      const items: unknown[] = [];
      if (raw[at] === "]") {
        at++;
        return items;
      }
      while (at < raw.length) {
        items.push(value(depth + 1));
        white();
        const separator = raw[at++];
        if (separator === "]") return items;
        if (separator !== ",") return invalid("Expected a JSON array separator.");
      }
      return invalid("Unterminated JSON array.");
    }
    for (const [literal, parsed] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (raw.startsWith(literal, at)) {
        at += literal.length;
        return parsed;
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(raw.slice(at));
    if (!number) return invalid("Invalid JSON value.");
    at += number[0].length;
    const parsed = Number(number[0]);
    return Number.isFinite(parsed) ? parsed : invalid("Manifest numbers must be finite.");
  };
  const parsed = value(0);
  white();
  if (at !== raw.length) return invalid("Unexpected trailing JSON.");
  return parsed;
}

function normalizedPath(raw: string): string {
  if (typeof raw !== "string" || !raw || Buffer.byteLength(raw, "utf8") > PACKAGE_LIMITS.pathBytes)
    return invalid("Invalid package path.");
  const path = raw.replace(/\\/g, "/").normalize("NFC");
  const components = path.split("/");
  if (
    Buffer.byteLength(path, "utf8") > PACKAGE_LIMITS.pathBytes ||
    /[\ud800-\udfff]/u.test(path) ||
    /^[A-Za-z]:/.test(path) ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Package paths must reject control bytes.
    /[\u0000-\u001f\u007f]/.test(path) ||
    components.some((part) => !part || part === "." || part === ".." || part.includes(":"))
  )
    return invalid("Package paths must be unambiguous relative file paths.");
  return path;
}

/** Conservative Unicode caseless key also catches expansions such as sharp-s and final sigma. */
const pathKey = (path: string) => path.toUpperCase().toLowerCase().normalize("NFC");
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const part of Object.values(value)) deepFreeze(part);
    Object.freeze(value);
  }
  return value;
}

/**
 * Freeze already supplied bytes as inert, serializable data. No extraction, fetching, dependency installation,
 * filesystem access or candidate execution happens here. Archive readers must apply limits before extraction too.
 * A digest proves integrity only: publication must still bind the expected digest to native policy and evidence.
 */
export function freezePackage(manifestJson: string, files: readonly PackageFile[]): FrozenPackage {
  const parsed = manifestSchema.safeParse(parseManifestJson(manifestJson));
  if (!parsed.success) return invalid("Invalid capability author manifest.");
  const manifest = parsed.data;
  if (!Array.isArray(files) || files.length < 1 || files.length > PACKAGE_LIMITS.files)
    return invalid("Package file count exceeds limits.");
  const seen = new Set<string>();
  let totalBytes = 0;
  const records = files
    .map((file) => {
      if (!file || file.kind !== "file" || (file.linkCount !== undefined && file.linkCount !== 1))
        return invalid("Only unlinked regular files may be packaged.");
      const path = normalizedPath(file.path);
      const key = pathKey(path);
      if (seen.has(key)) return invalid("Package paths collide after normalization or case folding.");
      seen.add(key);
      if (!(file.bytes instanceof Uint8Array) || file.bytes.byteLength > PACKAGE_LIMITS.fileBytes)
        return invalid("Package file bytes exceed limits.");
      totalBytes += file.bytes.byteLength;
      if (totalBytes > PACKAGE_LIMITS.totalBytes) return invalid("Expanded package exceeds the byte limit.");
      const bytes = Buffer.from(file.bytes);
      return { path, base64: bytes.toString("base64"), size: bytes.length, sha256: digest(bytes) };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const key of seen) {
    const parts = key.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (seen.has(parts.slice(0, i).join("/"))) return invalid("A package file cannot also be a directory.");
    }
  }
  const inventory = records.map(({ path, size, sha256 }) => ({ path, bytes: size, sha256 }));
  return deepFreeze({
    packageVersion: "foundry-package/1",
    manifest,
    manifestJson: canonicalJson(manifest),
    files: records.map(({ path, base64 }) => ({ path, base64 })),
    inventory,
    digest: digest(canonicalJson({ manifest, inventory })),
    totalBytes,
  });
}

/** Recompute from stored bytes, rejecting any changed metadata or noncanonical encoding. Not a grant/signature check. */
export function verifyPackage(bundle: FrozenPackage): boolean {
  try {
    const original = canonicalJson(bundle);
    if (
      bundle.packageVersion !== "foundry-package/1" ||
      !Array.isArray(bundle.files) ||
      bundle.files.length > PACKAGE_LIMITS.files
    )
      return false;
    const files: PackageFile[] = bundle.files.map(({ path, base64 }) => {
      if (typeof base64 !== "string" || base64.length > Math.ceil(PACKAGE_LIMITS.fileBytes / 3) * 4)
        return invalid("Invalid stored package bytes.");
      const bytes = Buffer.from(base64, "base64");
      if (bytes.toString("base64") !== base64) return invalid("Noncanonical package encoding.");
      return { path, bytes, kind: "file" };
    });
    return original === canonicalJson(freezePackage(bundle.manifestJson, files));
  } catch {
    return false;
  }
}

export function assertPackage(bundle: FrozenPackage): void {
  if (!verifyPackage(bundle))
    throw new FoundryPackageError("STALE_VERSION", "Stored package no longer matches its frozen bytes.");
}
