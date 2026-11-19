import { describe, expect, test } from "bun:test";
import {
  assertPackage,
  canonicalJson,
  FoundryPackageError,
  type FrozenPackage,
  freezePackage,
  type PackageFile,
  verifyPackage,
} from "../src/foundry/packages";

const manifest = () => ({
  schemaVersion: "1.0",
  name: "receipt-normalizer",
  version: "1.0.0",
  kind: "pure_tool",
  description: "Aggregate synthetic task receipts without converting unknown into success.",
  applicability: { useFor: ["Synthetic task receipts"], doNotUseFor: ["Invoices"] },
  scopeRequest: { level: "task", purpose: "Test a pure receipt transform" },
  effects: { network: "none", secrets: "none", filesystem: "none", externalActions: [], nestedCapabilities: [] },
  contracts: {
    input: { type: "object", properties: { records: { type: "array" } }, required: ["records"] },
    output: { type: "object", properties: { unknown: { type: "integer" } } },
  },
  dependencies: [] as { name: string; version: string; integrity: string; licenseDisposition: string }[],
  runtimeRequest: {
    profile: "pure-offline-v1",
    wallTimeMs: 10000,
    memoryMiB: 256,
    scratchMiB: 32,
    processes: 1,
    logBytesPerStream: 65536,
    inputBytes: 1048576,
    resultBytes: 1048576,
  },
  provenance: {
    origin: "generated",
    sourceRefs: ["synthetic-fixture"],
    licenseDisposition: "original_internal",
    containsPrivateData: false,
  },
  developmentTests: ["fixtures/basic.json"],
  rollback: { onFailure: "quarantine_and_revalidate_previous", previousNativeVersion: null },
});
const file = (path: string, text = "abc"): PackageFile => ({
  path,
  kind: "file",
  bytes: new TextEncoder().encode(text),
});
const freeze = (m = manifest(), files: readonly PackageFile[] = [file("tool.txt")]) =>
  freezePackage(JSON.stringify(m), files);
type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
const copy = (p: FrozenPackage): Mutable<FrozenPackage> => JSON.parse(JSON.stringify(p));
const rejected = (act: () => unknown) => {
  try {
    act();
    throw new Error("Unexpectedly accepted an invalid package");
  } catch (error) {
    expect(error).toBeInstanceOf(FoundryPackageError);
    expect((error as FoundryPackageError).code).toBe("SCHEMA_INVALID");
  }
};

describe("immutable inert capability packages", () => {
  test("freezes actual bytes with independently known hashes and sorted normalized paths", () => {
    const result = freeze(manifest(), [file("z.txt", ""), file("cafe\u0301.txt")]);
    expect(result.inventory).toEqual([
      { path: "caf\u00e9.txt", bytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
      { path: "z.txt", bytes: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
    ]);
    expect(result.files).toEqual([
      { path: "caf\u00e9.txt", base64: "YWJj" },
      { path: "z.txt", base64: "" },
    ]);
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.totalBytes).toBe(3);
    expect(verifyPackage(result)).toBe(true);
    expect(verifyPackage(copy(result))).toBe(true);
  });

  test("identity survives JSON key order, whitespace, file order and Unicode path normalization", () => {
    const original = manifest();
    const reordered = Object.fromEntries(Object.entries(original).reverse());
    const a = freezePackage(JSON.stringify(original), [file("b.txt"), file("cafe\u0301.txt")]);
    const b = freezePackage(JSON.stringify(reordered, null, 2), [file("caf\u00e9.txt"), file("b.txt")]);
    expect(a.digest).toBe(b.digest);
    expect(canonicalJson({ z: 1, a: { y: true, b: null } })).toBe('{"a":{"b":null,"y":true},"z":1}');
  });

  test("schema, resource and dependency changes cannot reuse the evaluated digest", () => {
    const before = freeze();
    const changed = manifest();
    changed.contracts.input.required = [];
    expect(freeze(changed).digest).not.toBe(before.digest);
    expect(freeze(manifest(), [file("tool.txt", "changed")]).digest).not.toBe(before.digest);
    const deps = manifest();
    deps.dependencies.push({
      name: "dependency",
      version: "1.2.3",
      integrity: "a".repeat(64),
      licenseDisposition: "review_required",
    });
    expect(freeze(deps).digest).not.toBe(before.digest);
  });

  test("later changes to input buffers cannot alter the frozen package", () => {
    const input = file("tool.txt");
    const result = freeze(manifest(), [input]);
    input.bytes[0] = 0;
    expect(result.files[0]?.base64).toBe("YWJj");
    expect(verifyPackage(result)).toBe(true);
    expect(() => Reflect.set(result.manifest, "description", "changed")).not.toThrow();
    expect(result.manifest.description).not.toBe("changed");
  });

  test.each([
    (p: Mutable<FrozenPackage>) => {
      p.files[0]!.base64 = "YQ==";
    },
    (p: Mutable<FrozenPackage>) => {
      p.inventory[0]!.sha256 = "a".repeat(64);
    },
    (p: Mutable<FrozenPackage>) => {
      p.manifest.description = "changed";
    },
    (p: Mutable<FrozenPackage>) => {
      p.manifestJson = "{}";
    },
    (p: Mutable<FrozenPackage>) => {
      p.totalBytes = 999;
    },
    (p: Mutable<FrozenPackage>) => {
      p.files[0]!.base64 = "YWJj=";
    },
    (p: Mutable<FrozenPackage>) => {
      p.files[0]!.path = "../escape";
    },
    (p: Mutable<FrozenPackage>) => {
      p.inventory[0]!.bytes = 999;
    },
  ])("detects stale serialized package data before dispatch", (tamper) => {
    const altered = copy(freeze());
    tamper(altered);
    expect(verifyPackage(altered)).toBe(false);
    expect(() => assertPackage(altered)).toThrow(FoundryPackageError);
    try {
      assertPackage(altered);
    } catch (error) {
      expect((error as FoundryPackageError).code).toBe("STALE_VERSION");
    }
  });

  test("rejects duplicate JSON keys including escaped and nested keys before schema validation", () => {
    const good = JSON.stringify(manifest());
    rejected(() => freezePackage(good.replace('"name":', '"na\\u006de":"other","name":'), [file("tool.txt")]));
    rejected(() => freezePackage(good.replace('"useFor":', '"useFor":[],"useFor":'), [file("tool.txt")]));
    rejected(() => freezePackage(good.replace('"type":"array"', '"type":"array","type":"object"'), [file("tool.txt")]));
  });

  test.each([
    "../escape",
    "/absolute",
    "C:/absolute",
    "C:relative",
    "a//b",
    "a/./b",
    "a/../b",
    "a/",
    "",
    ".",
    "a\\..\\b",
    "\\absolute",
    "a\u0000b",
  ])("rejects path traversal and ambiguous path %s without extraction", (path) =>
    rejected(() => freeze(manifest(), [file(path)])),
  );

  test.each([
    ["same.txt", "same.txt"],
    ["a\\b.txt", "a/b.txt"],
    ["CAF\u00c9.txt", "cafe\u0301.txt"],
    ["stra\u00dfe.txt", "STRASSE.txt"],
  ])("rejects duplicate, separator, normalization or case-fold collisions", (left, right) => {
    rejected(() =>
      freeze(
        manifest(),
        [left, right].map((path) => file(path)),
      ),
    );
  });

  test.each(["directory", "symlink", "hardlink", "device"] as const)("rejects a %s entry", (kind) => {
    rejected(() => freeze(manifest(), [{ ...file("tool.txt"), kind }]));
  });

  test("rejects regular-file metadata that reports more than one hard link", () => {
    rejected(() => freeze(manifest(), [{ ...file("tool.txt"), linkCount: 2 }]));
  });

  test("bounds count, per-file bytes, total expanded bytes and manifest bytes", () => {
    rejected(() =>
      freeze(
        manifest(),
        Array.from({ length: 101 }, (_, i) => file(`f${i}.txt`)),
      ),
    );
    rejected(() => freeze(manifest(), [{ ...file("large"), bytes: new Uint8Array(1048577) }]));
    rejected(() =>
      freeze(
        manifest(),
        Array.from({ length: 9 }, (_, i) => ({ ...file(`f${i}`), bytes: new Uint8Array(1048576) })),
      ),
    );
    rejected(() => freezePackage(" ".repeat(65537), [file("tool.txt")]));
  });

  test("rejects missing contracts, unknown authority fields and malformed raw JSON", () => {
    const missing = { ...manifest(), contracts: undefined };
    rejected(() => freezePackage(JSON.stringify(missing), [file("tool.txt")]));
    rejected(() => freezePackage(JSON.stringify({ ...manifest(), approved: true }), [file("tool.txt")]));
    rejected(() => freezePackage(JSON.stringify(manifest()) + " trailing", [file("tool.txt")]));
    rejected(() => freezePackage('{"name":', [file("tool.txt")]));
    rejected(() => freeze(manifest(), []));
  });

  test("rejects unsafe numeric JSON and excessively nested contracts", () => {
    const good = JSON.stringify(manifest());
    rejected(() => freezePackage(good.replace('"type":"array"', '"type":"array","minimum":1e999'), [file("tool.txt")]));
    const deep = '{"type":"object","properties":{"x":'.repeat(40) + "{}" + "}}".repeat(40);
    rejected(() => freezePackage(good.replace('{"type":"array"}', deep), [file("tool.txt")]));
  });

  test.each(["latest", "*", "^1.0.0", "~1.0.0", "1.x", "https://example.test/code"])(
    "rejects unpinned dependency %s",
    (version) => {
      const m = manifest();
      m.dependencies.push({ name: "dep", version, integrity: "a".repeat(64), licenseDisposition: "reviewed_allowed" });
      rejected(() => freeze(m));
    },
  );

  test("rejects missing integrity and undeclared dependency installer options", () => {
    const m = manifest();
    m.dependencies.push({ name: "dep", version: "1.0.0", integrity: "", licenseDisposition: "reviewed_allowed" });
    rejected(() => freeze(m));
    const installer = {
      ...manifest(),
      dependencies: [
        {
          name: "dep",
          version: "1.0.0",
          integrity: "a".repeat(64),
          licenseDisposition: "reviewed_allowed",
          postinstall: "send-data",
        },
      ],
    };
    rejected(() => freezePackage(JSON.stringify(installer), [file("tool.txt")]));
  });

  test("rejects pure tools requesting effects or missing bounded runtime", () => {
    rejected(() => freezePackage(JSON.stringify({ ...manifest(), runtimeRequest: null }), [file("tool.txt")]));
    const m = manifest();
    m.effects.network = "broker_allowlist";
    rejected(() => freeze(m));
    const oversized = manifest();
    oversized.runtimeRequest.memoryMiB = 257;
    rejected(() => freeze(oversized));
  });

  test.each(["\ud800.txt", "\udfff.txt"])(
    "rejects ill-formed Unicode path %s before UTF-8 replacement can collide",
    (path) => {
      rejected(() => freeze(manifest(), [file(path)]));
    },
  );

  test("rejects a file that is also another file's parent, including case-folded parents", () => {
    rejected(() => freeze(manifest(), [file("tool"), file("tool/data.json")]));
    rejected(() => freeze(manifest(), [file("TOOL"), file("tool/data.json")]));
  });

  test("canonicalization refuses executable JavaScript objects rather than evaluating them", () => {
    let getterCalls = 0;
    const getter = Object.defineProperty({}, "data", {
      enumerable: true,
      get() {
        getterCalls++;
        return "secret";
      },
    });
    rejected(() => canonicalJson(getter));
    expect(getterCalls).toBe(0);
    rejected(() => canonicalJson({ value: undefined }));
    rejected(() => canonicalJson({ value: Number.NaN }));
  });
});
