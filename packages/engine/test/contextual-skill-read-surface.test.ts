import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sealSkillReadSurface } from "../src/contextual-skill-read-surface";
import { sha256 } from "../src/crypto";

const id = "11111111-1111-4111-8111-111111111111";
const bytes = (text: string) => new TextEncoder().encode(text);
function input() {
  return {
    selected: {
      orgId: id,
      skillId: id,
      version: 1,
      operation: "stored_text",
      path: "refs/test.txt",
      mime: "text/plain",
    },
    result: { type: "result", output: { content: "native prefix:\n廣東話 😀 e\u0301\r\n" } },
    sidecar: {
      rawSelectedBytes: bytes("廣東話 😀 e\u0301\r\n"),
      listing: null as string | null,
      preGatewayContent: "native prefix:\n廣東話 😀 e\u0301\r\n",
      finalizerSuffix: null as string | null,
    },
    flags: { complete: true, readerTruncated: false, gatewayTruncated: false, omitted: false, sanitized: false },
  };
}

test("seals exact final UTF8 and raw bytes separately without granting authority or exposing text", () => {
  const value = input();
  const result = sealSkillReadSurface(value);
  expect(result.status).toBe("sealed_observation");
  if (result.status !== "sealed_observation") throw Error("fixture not sealed");
  expect(result.descriptor).toMatchObject({
    authority: false,
    canExecute: false,
    capture: "unverified",
    sourceContextPrivacy: "unverified",
    fullPackage: false,
    returnedBytesHash: sha256(value.result.output.content),
    rawSelectedBytesHash: createHash("sha256").update(value.sidecar.rawSelectedBytes).digest("hex"),
    flags: { complete: true, truncated: false, omitted: false, sanitized: false },
  });
  expect(result.descriptor.returnedBytesHash).not.toBe(result.descriptor.rawSelectedBytesHash);
  expect(Buffer.from(result.readReturnedBytes()).toString("utf8")).toBe(value.result.output.content);
  expect(JSON.stringify(result)).not.toContain("廣東話");
});

test("sealed buffer and frozen descriptor cannot be changed by caller mutation", () => {
  const value = input();
  const result = sealSkillReadSurface(value);
  if (result.status !== "sealed_observation") throw Error("fixture not sealed");
  const before = JSON.stringify(result.descriptor);
  const returned = result.readReturnedBytes();
  returned.fill(0);
  value.sidecar.rawSelectedBytes.fill(0);
  value.result.output.content = "changed";
  value.selected.version = 9;
  expect(JSON.stringify(result.descriptor)).toBe(before);
  expect(result.readReturnedBytes()[0]).not.toBe(0);
  expect(Object.isFrozen(result.descriptor)).toBe(true);
  expect(Object.isFrozen(result.descriptor.flags)).toBe(true);
});

test("Unicode normalization, line endings and native prefix changes change the correct digest", () => {
  const first = input();
  const a = sealSkillReadSurface(first);
  first.result.output.content = first.result.output.content.normalize("NFC");
  first.sidecar.preGatewayContent = first.result.output.content;
  const b = sealSkillReadSurface(first);
  if (a.status !== "sealed_observation" || b.status !== "sealed_observation") throw Error("fixture not sealed");
  expect(a.descriptor.returnedBytesHash).not.toBe(b.descriptor.returnedBytesHash);
  expect(a.descriptor.rawSelectedBytesHash).toBe(b.descriptor.rawSelectedBytesHash);
  expect(a.descriptor.contentHash).not.toBe(b.descriptor.contentHash);
});

test("same-version same-size selected byte drift is visible even if sanitized display stays the same", () => {
  const a = input();
  a.sidecar.rawSelectedBytes = new Uint8Array([97, 0, 98]);
  const b = input();
  b.sidecar.rawSelectedBytes = new Uint8Array([97, 0, 99]);
  const first = sealSkillReadSurface(a),
    next = sealSkillReadSurface(b);
  if (first.status !== "sealed_observation" || next.status !== "sealed_observation") throw Error("fixture not sealed");
  expect(first.descriptor.returnedBytesHash).toBe(next.descriptor.returnedBytesHash);
  expect(first.descriptor.rawSelectedBytesHash).not.toBe(next.descriptor.rawSelectedBytesHash);
  expect(first.descriptor.manifestDigest).not.toBe(next.descriptor.manifestDigest);
});

test("native sanitizer sidecar is observed using existing pgSafeText, never silently reapplied", () => {
  const value = input();
  value.sidecar.preGatewayContent = "a\0b";
  value.result.output.content = "ab";
  value.flags.sanitized = true;
  value.flags.complete = false;
  const result = sealSkillReadSurface(value);
  expect(result.status).toBe("sealed_observation");
  value.flags.sanitized = false;
  expect(sealSkillReadSurface(value).status).toBe("unqualified");
  value.flags.sanitized = true;
  value.result.output.content = "a\0b";
  expect(sealSkillReadSurface(value).status).toBe("unqualified");
});

test("explicit gateway truncation requires captured suffix and a coherent prefix, not a copied cap algorithm", () => {
  const value = input();
  value.sidecar.preGatewayContent = "abcde";
  value.result.output.content = "abc\n[truncated]";
  value.flags.gatewayTruncated = true;
  value.flags.complete = false;
  expect(sealSkillReadSurface(value).status).toBe("unqualified");
  value.sidecar.finalizerSuffix = "\n[truncated]";
  const result = sealSkillReadSurface(value);
  expect(result.status).toBe("sealed_observation");
  if (result.status === "sealed_observation") expect(result.descriptor.flags.truncated).toBe(true);
  value.result.output.content = "FOREIGN\n[truncated]";
  expect(sealSkillReadSurface(value).status).toBe("unqualified");
});

test("reader truncation and omission remain explicit partial observations, never full-package hashes", () => {
  const value = input();
  value.flags.readerTruncated = true;
  value.flags.complete = false;
  const result = sealSkillReadSurface(value);
  expect(result.status).toBe("sealed_observation");
  if (result.status === "sealed_observation")
    expect(result.descriptor).toMatchObject({
      fullPackage: false,
      capture: "unverified",
      flags: { complete: false, truncated: true },
    });
  value.flags.complete = true;
  expect(sealSkillReadSurface(value).status).toBe("unqualified");
});

for (const [label, mutate] of [
  [
    "error",
    (v: ReturnType<typeof input>) => {
      Object.assign(v.result.output, { isError: true });
    },
  ],
  [
    "image",
    (v: ReturnType<typeof input>) => {
      Object.assign(v.result.output, { images: [{ mediaType: "image/png", data: "synthetic" }] });
    },
  ],
  [
    "script",
    (v: ReturnType<typeof input>) => {
      v.selected.path = "run.sh";
    },
  ],
  [
    "binary",
    (v: ReturnType<typeof input>) => {
      v.selected.path = "image.png";
      v.selected.mime = "image/png";
    },
  ],
  [
    "traversal",
    (v: ReturnType<typeof input>) => {
      v.selected.path = "../test.txt";
    },
  ],
  [
    "dot alias",
    (v: ReturnType<typeof input>) => {
      v.selected.path = "./refs/test.txt";
    },
  ],
  [
    "wrong version",
    (v: ReturnType<typeof input>) => {
      v.selected.version = 0;
    },
  ],
  [
    "unknown flag",
    (v: ReturnType<typeof input>) => {
      Object.assign(v.flags, { omitted: undefined });
    },
  ],
  [
    "authority claim",
    (v: ReturnType<typeof input>) => {
      Object.assign(v, { serverVerified: true });
    },
  ],
  [
    "missing raw source",
    (v: ReturnType<typeof input>) => {
      Object.assign(v.sidecar, { rawSelectedBytes: null });
    },
  ],
  [
    "nonfinalized content",
    (v: ReturnType<typeof input>) => {
      v.result.output.content = "different";
    },
  ],
] as const) {
  test(`${label} remains unqualified with no returned bytes`, () => {
    const value = input();
    mutate(value);
    const result = sealSkillReadSurface(value);
    expect(result).toMatchObject({ status: "unqualified", authority: false, canExecute: false });
    expect("readReturnedBytes" in result).toBe(false);
  });
}

test("folder and body listing sidecars bind exact native text without a renderer", () => {
  const base = input();
  const folder = {
    ...base,
    selected: { ...base.selected, operation: "folder_listing", path: "refs/", mime: null },
    sidecar: { ...base.sidecar, rawSelectedBytes: null, listing: "refs/a.txt\nrefs/b.txt" },
  };
  folder.result = { type: "result", output: { content: folder.sidecar.listing } };
  folder.sidecar.preGatewayContent = folder.sidecar.listing;
  const a = sealSkillReadSurface(folder);
  expect(a.status).toBe("sealed_observation");
  const body = {
    ...base,
    selected: { ...base.selected, operation: "load_skill", path: null, mime: null },
    sidecar: { ...base.sidecar, listing: "native bounded listing" },
    flags: { ...base.flags, complete: false, omitted: true },
  };
  body.result = { type: "result", output: { content: `native body and wrapper\n${body.sidecar.listing}` } };
  body.sidecar.preGatewayContent = body.result.output.content;
  const b = sealSkillReadSurface(body);
  expect(b.status).toBe("sealed_observation");
  if (b.status === "sealed_observation") expect(b.descriptor.boundedListingHash).toBe(sha256("native bounded listing"));
});

test("existing native gateway output is sealed byte-for-byte without re-rendering or a model call", async () => {
  const { setup } = await import("./fixtures");
  const { schema, eq } = await import("@agenteschat/db");
  const { postPersonMessage, saveSkill, setAgentSkills } = await import("../src");
  const f = await setup({ skillTools: true });
  try {
    const body = "Actual native fixture body 廣東話 😀\r\n";
    const skill = await saveSkill({ db: f.db, blobs: f.artifactDeps.blobs }, f.owner.id, f.org.id, {
      name: "seal-fixture",
      description: "Synthetic native capture",
      body,
      source: "manual",
      metadata: {},
      files: [],
    });
    await setAgentSkills(f.db, f.owner.id, f.org.id, f.agent.id, [{ skillId: skill.id, enabled: true }]);
    const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev fixture",
    });
    const [run] = await f.db
      .update(schema.agentRuns)
      .set({ status: "running" })
      .where(eq(schema.agentRuns.triggerMessageId, trigger.id))
      .returning();
    if (!run || !f.tools) throw Error("native fixture missing");
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run.id,
      channelId: run.channelId,
      triggerMessageId: run.triggerMessageId,
      threadRootId: run.threadRootId,
    };
    const result = await f.tools.invoke(ctx, {
      toolUseId: "surface-native-control",
      name: "load_skill",
      input: { name: "seal-fixture" },
    });
    if (result.type !== "result" || result.output.isError) throw Error("native read failed");
    const captured = sealSkillReadSurface({
      selected: {
        orgId: f.org.id,
        skillId: skill.id,
        version: skill.version,
        operation: "load_skill",
        path: null,
        mime: null,
      },
      result,
      sidecar: {
        rawSelectedBytes: bytes(body),
        listing: "(no files)",
        preGatewayContent: result.output.content,
        finalizerSuffix: null,
      },
      flags: { complete: true, readerTruncated: false, gatewayTruncated: false, omitted: false, sanitized: false },
    });
    expect(captured.status).toBe("sealed_observation");
    if (captured.status !== "sealed_observation") throw Error("native capture not sealed");
    expect(Buffer.from(captured.readReturnedBytes()).toString("utf8")).toBe(result.output.content);
    expect(captured.descriptor.returnedBytesHash).toBe(sha256(result.output.content));
    expect(captured.descriptor.authority).toBe(false);
    expect(f.provider.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("manifest binds the exact observed finalizer suffix without changing returned-content digest", () => {
  const value = input();
  value.sidecar.preGatewayContent = "abcde";
  value.result.output.content = "abcX";
  value.flags.gatewayTruncated = true;
  value.flags.complete = false;
  value.sidecar.finalizerSuffix = "X";
  const a = sealSkillReadSurface(value);
  value.sidecar.finalizerSuffix = "cX";
  const b = sealSkillReadSurface(value);
  if (a.status !== "sealed_observation" || b.status !== "sealed_observation") throw Error("fixture not sealed");
  expect(a.descriptor.returnedBytesHash).toBe(b.descriptor.returnedBytesHash);
  expect(a.descriptor.manifestDigest).not.toBe(b.descriptor.manifestDigest);
});

test("body-read reader-truncation is unqualified rather than conflated with the gateway cap", () => {
  const value = input();
  expect(
    sealSkillReadSurface({
      ...value,
      selected: { ...value.selected, operation: "load_skill", path: null, mime: null },
      sidecar: { ...value.sidecar, listing: "" },
      flags: { ...value.flags, complete: false, readerTruncated: true },
    }).status,
  ).toBe("unqualified");
});
