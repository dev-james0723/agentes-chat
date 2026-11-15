import { createHash } from "node:crypto";
import { sha256 } from "./crypto";
import { pgSafeText } from "./format";
import { classifyFile, SKILL_LIMITS } from "./skills";
import { MAX_RESULT_CHARS } from "./tools/gateway";
import { canonicalJson } from "./tools/json-schema";

const SCHEMA = "content-surface-v1";
const uuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
function data(v: unknown): v is Record<string, unknown> {
  return Boolean(
    v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null) &&
      Object.values(Object.getOwnPropertyDescriptors(v)).every((d) => "value" in d),
  );
}
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  data(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const rawHash = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
function pathQualified(path: unknown, folder: boolean): path is string {
  if (folder && path === "./") return true;
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 300 &&
    !path.includes("\\") &&
    ![...path].some((c) => c.charCodeAt(0) < 32) &&
    !path.startsWith("/") &&
    path.endsWith("/") === folder &&
    path
      .replace(/\/$/, "")
      .split("/")
      .every((s) => s !== "" && s !== "." && s !== "..")
  );
}
export interface SkillReadSurfaceDescriptor {
  schema: typeof SCHEMA;
  selected: Readonly<{
    orgId: string;
    skillId: string;
    version: number;
    operation: "load_skill" | "stored_text" | "folder_listing";
    path: string | null;
    mime: string | null;
  }>;
  returnedBytesHash: string;
  returnedBytes: number;
  rawSelectedBytesHash: string | null;
  rawSelectedBytes: number | null;
  boundedListingHash: string | null;
  preGatewayContentHash: string;
  finalizerSuffixHash: string | null;
  contentHash: string;
  manifestDigest: string;
  flags: Readonly<{
    complete: boolean;
    truncated: boolean;
    readerTruncated: boolean;
    gatewayTruncated: boolean;
    omitted: boolean;
    sanitized: boolean;
  }>;
  capture: "unverified";
  transformationEvidence: "unverified_capture";
  sourceContextPrivacy: "unverified";
  fullPackage: false;
  authority: false;
  canExecute: false;
}
export type SkillReadSurfaceSeal =
  | { status: "unqualified"; reason: string; authority: false; canExecute: false }
  | {
      status: "sealed_observation";
      authority: false;
      canExecute: false;
      descriptor: Readonly<SkillReadSurfaceDescriptor>;
      readReturnedBytes(): Uint8Array;
    };

/**
 * Pure sealing of a future server capture, not a reader, formatter, finalizer or native authority verifier.
 * Native handlers must supply actual post-gateway output and selected-source/listing sidecars. Passing TS types,
 * flags or model strings never establishes their provenance. No store/issuer/CAS/ALLOW, IO or automatic caller.
 */
export function sealSkillReadSurface(input: unknown): SkillReadSurfaceSeal {
  const no = (reason: string): SkillReadSurfaceSeal => ({
    status: "unqualified",
    reason,
    authority: false,
    canExecute: false,
  });
  try {
    if (
      !exact(input, ["selected", "result", "sidecar", "flags"]) ||
      !exact(input.selected, ["orgId", "skillId", "version", "operation", "path", "mime"]) ||
      !exact(input.sidecar, ["rawSelectedBytes", "listing", "preGatewayContent", "finalizerSuffix"]) ||
      !exact(input.flags, ["complete", "readerTruncated", "gatewayTruncated", "omitted", "sanitized"])
    )
      return no("capture_shape_unknown");
    const s = input.selected,
      side = input.sidecar,
      f = input.flags;
    if (
      !uuid(s.orgId) ||
      !uuid(s.skillId) ||
      typeof s.version !== "number" ||
      !Number.isSafeInteger(s.version) ||
      s.version < 1 ||
      !Object.values(f).every((v) => typeof v === "boolean")
    )
      return no("capture_binding_unknown");
    if (!exact(input.result, ["type", "output"]) || input.result.type !== "result" || !data(input.result.output))
      return no("not_text_result");
    const output = input.result.output;
    if (
      Object.keys(output).some((k) => !["content", "data", "isError", "images"].includes(k)) ||
      (output.isError !== undefined && output.isError !== false) ||
      (output.images !== undefined && (!Array.isArray(output.images) || output.images.length !== 0)) ||
      typeof output.content !== "string"
    )
      return no("not_successful_text");
    const content = output.content;
    if (
      content.length > MAX_RESULT_CHARS + 64 ||
      pgSafeText(content) !== content ||
      typeof side.preGatewayContent !== "string" ||
      side.preGatewayContent.length > SKILL_LIMITS.bodyChars + SKILL_LIMITS.maxFiles * 512
    )
      return no("final_text_unqualified");
    if (f.complete !== !(f.readerTruncated || f.gatewayTruncated || f.omitted || f.sanitized))
      return no("inconsistent_completeness");
    const safeBefore = pgSafeText(side.preGatewayContent);
    if (f.sanitized !== (safeBefore !== side.preGatewayContent)) return no("sanitization_unknown");
    if (!f.gatewayTruncated) {
      if (side.finalizerSuffix !== null || content !== safeBefore) return no("finalization_unknown");
    } else {
      // Validate captured prefix/suffix relation only; never reproduce the gateway cap or infer its suffix.
      const suffix = side.finalizerSuffix;
      if (typeof suffix !== "string" || suffix.length === 0 || suffix.length > 64 || !content.endsWith(suffix))
        return no("truncation_unknown");
      const prefix = content.slice(0, -suffix.length);
      if (prefix.length >= safeBefore.length || !safeBefore.startsWith(prefix)) return no("truncation_unknown");
    }
    let operation: SkillReadSurfaceDescriptor["selected"]["operation"];
    if (s.operation === "load_skill") {
      if (
        f.readerTruncated ||
        s.path !== null ||
        s.mime !== null ||
        typeof side.listing !== "string" ||
        !side.preGatewayContent.endsWith(side.listing)
      )
        return no("body_surface_unknown");
      operation = "load_skill";
    } else if (s.operation === "stored_text") {
      if (
        !pathQualified(s.path, false) ||
        classifyFile(s.path).kind !== "text" ||
        s.mime !== classifyFile(s.path).mime ||
        side.listing !== null
      )
        return no("selected_text_unknown");
      operation = "stored_text";
    } else if (s.operation === "folder_listing") {
      if (
        !pathQualified(s.path, true) ||
        s.mime !== null ||
        typeof side.listing !== "string" ||
        side.rawSelectedBytes !== null ||
        f.readerTruncated
      )
        return no("folder_surface_unknown");
      // Empty folders have a native explanatory string. Do not create or localize that string here.
      if (side.listing !== "" && side.preGatewayContent !== side.listing) return no("folder_surface_unknown");
      operation = "folder_listing";
    } else return no("operation_unsupported");
    const raw = side.rawSelectedBytes;
    if (operation !== "folder_listing" && (!(raw instanceof Uint8Array) || raw.byteLength > SKILL_LIMITS.maxBytes))
      return no("raw_source_unknown");
    if (typeof side.listing === "string" && side.listing.length > SKILL_LIMITS.maxFiles * 512)
      return no("listing_unbounded");
    const rawCopy = raw instanceof Uint8Array ? new Uint8Array(raw) : null;
    const returned = new TextEncoder().encode(content);
    const selected = Object.freeze({
      orgId: s.orgId,
      skillId: s.skillId,
      version: s.version,
      operation,
      path: s.path as string | null,
      mime: s.mime as string | null,
    });
    const returnedBytesHash = rawHash(returned);
    const boundedListingHash = typeof side.listing === "string" ? sha256(side.listing) : null;
    const flags = Object.freeze({
      complete: f.complete as boolean,
      truncated: Boolean(f.readerTruncated || f.gatewayTruncated),
      readerTruncated: f.readerTruncated as boolean,
      gatewayTruncated: f.gatewayTruncated as boolean,
      omitted: f.omitted as boolean,
      sanitized: f.sanitized as boolean,
    });
    const contentHash = sha256(canonicalJson({ schema: SCHEMA, ...selected, returnedBytesHash, boundedListingHash }));
    const values: Omit<SkillReadSurfaceDescriptor, "manifestDigest"> = {
      schema: SCHEMA,
      selected,
      returnedBytesHash,
      returnedBytes: returned.byteLength,
      rawSelectedBytesHash: rawCopy ? rawHash(rawCopy) : null,
      rawSelectedBytes: rawCopy?.byteLength ?? null,
      boundedListingHash,
      preGatewayContentHash: sha256(side.preGatewayContent),
      finalizerSuffixHash: typeof side.finalizerSuffix === "string" ? sha256(side.finalizerSuffix) : null,
      contentHash,
      flags,
      capture: "unverified" as const,
      transformationEvidence: "unverified_capture" as const,
      sourceContextPrivacy: "unverified" as const,
      fullPackage: false as const,
      authority: false as const,
      canExecute: false as const,
    };
    const descriptor = Object.freeze({
      ...values,
      manifestDigest: sha256(canonicalJson({ domain: "skill-read-capture-v1", ...values })),
    });
    return Object.freeze({
      status: "sealed_observation" as const,
      authority: false as const,
      canExecute: false as const,
      descriptor,
      readReturnedBytes: () => new Uint8Array(returned),
    });
  } catch {
    return no("capture_unavailable");
  }
}
