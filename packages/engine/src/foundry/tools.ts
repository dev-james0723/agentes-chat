import { and, eq, isNull, schema } from "@agenteschat/db";
import { type JsonSchema, validateJson } from "../tools/json-schema";
import type { CallCheck, ToolContext, ToolDefinition, ToolOutput, ToolSource } from "../tools/types";
import { foundryDraftGuidance } from "./guidance";
import {
  createFoundryLifecycle,
  FOUNDRY_ACTIVATE_TOOL,
  type FoundryActivationInput,
  type FoundryLifecycleDependencies,
  foundryToolName,
} from "./lifecycle";
import { FoundryPackageError, freezePackage, PACKAGE_LIMITS, type PackageFile } from "./packages";
import { RECEIPT_CONTRACT_ID, RECEIPT_INPUT_SCHEMA, receiptAppliesTo, validateReceiptInput } from "./receipt-contract";
import { createFoundryService, FOUNDRY_NATIVE_CONTRACT, FoundryError, foundryContext } from "./service";

const idSchema: JsonSchema = {
  type: "string",
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
  minLength: 36,
  maxLength: 36,
};
const digestSchema: JsonSchema = { type: "string", pattern: "^[a-f0-9]{64}$", minLength: 64, maxLength: 64 };
const textSchema = (maxLength: number): JsonSchema => ({ type: "string", minLength: 1, maxLength });
const revisionSchema: JsonSchema = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const callsSchema: JsonSchema = { type: "integer", minimum: 2, maximum: 100 };
const dateSchema: JsonSchema = { type: "string", minLength: 20, maxLength: 64 };
function objectSchema(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}
const proposalSchema = objectSchema({ needKey: { type: "string", enum: [RECEIPT_CONTRACT_ID] } });
const versionSchema = objectSchema({ candidateId: idSchema, digest: digestSchema });
const prepareSchema = objectSchema({
  candidateId: idSchema,
  digest: digestSchema,
  maxCalls: callsSchema,
  validUntil: dateSchema,
});
const bindingSchema = objectSchema({ bindingId: idSchema });
const activationSchema = objectSchema({
  candidateId: idSchema,
  candidateRevision: revisionSchema,
  versionDigest: digestSchema,
  contractDigest: digestSchema,
  effectsDigest: digestSchema,
  taskId: idSchema,
  agentId: idSchema,
  personId: textSchema(200),
  evaluationRef: textSchema(1000),
  runtimeDigest: digestSchema,
  profileDigest: digestSchema,
  validUntil: dateSchema,
  maxCalls: callsSchema,
  previousBindingId: { ...idSchema, type: ["string", "null"] },
});
const stageScalarsSchema = objectSchema({
  candidateId: idSchema,
  revision: revisionSchema,
  manifestJson: textSchema(PACKAGE_LIMITS.manifestBytes),
});
/** A file as UTF-8 `text` (preferred: models write text reliably) or canonical `base64`, exactly one of them. */
const fileProperties: Record<"path" | "text" | "base64", JsonSchema> = {
  path: textSchema(PACKAGE_LIMITS.pathBytes),
  text: { type: "string", maxLength: PACKAGE_LIMITS.fileBytes, description: "The file as UTF-8 text." },
  base64: {
    type: "string",
    maxLength: Math.ceil(PACKAGE_LIMITS.fileBytes / 3) * 4,
    description: "The file as canonical base64, only for bytes that are not text. Give text or base64, not both.",
  },
};
const fileSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: fileProperties,
};
const stageSchema = objectSchema({
  ...(stageScalarsSchema.properties as Record<string, JsonSchema>),
  files: { type: "array", minItems: 1, maxItems: PACKAGE_LIMITS.files, items: fileSchema },
});

function invalid(): never {
  throw new FoundryError("SCHEMA_INVALID");
}
/** A refusal the builder can act on: names the field and the fix, never protected evaluation data. */
function refuse(reason: string): never {
  throw new FoundryPackageError("SCHEMA_INVALID", reason);
}

/** Tool arguments are JSON data only; never invoke a supplied getter or accept an inherited field. */
function ownData(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length) return invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of actual) {
    if (typeof key !== "string" || !keys.includes(key)) return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return invalid();
    result[key] = descriptor.value;
  }
  return result;
}

/** The Gateway handles schema validation too; these checks defend direct native calls and format constraints. */
function scalarArgs<T>(input: unknown, inputSchema: JsonSchema): T {
  const properties = inputSchema.properties as Record<string, JsonSchema>;
  const value = ownData(input, Object.keys(properties));
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && typeof item !== "string" && typeof item !== "number") return invalid();
    const property = properties[key]!;
    if (typeof item === "string" && typeof property.pattern === "string" && !new RegExp(property.pattern).test(item))
      return invalid();
    if (property.type === "integer" && !Number.isSafeInteger(item)) return invalid();
  }
  if (validateJson(inputSchema, value).length) return invalid();
  if ("validUntil" in value && !Number.isFinite(Date.parse(value.validUntil as string))) return invalid();
  return value as T;
}

type StageScalars = { candidateId: string; revision: number; manifestJson: string };
function stageArgs(input: unknown) {
  const raw = ownData(input, ["candidateId", "revision", "manifestJson", "files"]);
  const scalars = scalarArgs<StageScalars>(
    {
      candidateId: raw.candidateId,
      revision: raw.revision,
      manifestJson: raw.manifestJson,
    },
    stageScalarsSchema,
  );
  if (Buffer.byteLength(scalars.manifestJson, "utf8") > PACKAGE_LIMITS.manifestBytes) return invalid();
  if (!Array.isArray(raw.files) || Object.getPrototypeOf(raw.files) !== Array.prototype) return invalid();
  const length = Object.getOwnPropertyDescriptor(raw.files, "length")?.value;
  if (
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > PACKAGE_LIMITS.files ||
    Reflect.ownKeys(raw.files).length !== length + 1
  )
    return invalid();
  const files: PackageFile[] = [];
  let total = 0;
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw.files, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return invalid();
    const at = `files[${index}]`;
    const value = descriptor.value as Record<string, unknown> | null;
    const form = value && typeof value === "object" && "text" in value ? "text" : "base64";
    if (value && typeof value === "object" && "text" in value && "base64" in value)
      return refuse(`${at}: give text or base64, not both`);
    const file = scalarArgs<{ path: string; text?: string; base64?: string }>(
      descriptor.value,
      objectSchema({ path: fileProperties.path, [form]: fileProperties[form] }),
    );
    const bytes = form === "text" ? Buffer.from(file.text ?? "", "utf8") : Buffer.from(file.base64 ?? "", "base64");
    total += bytes.byteLength;
    if (form === "base64" && bytes.toString("base64") !== file.base64)
      return refuse(`${at}: base64 is not canonical; send the file as text instead`);
    if (bytes.byteLength > PACKAGE_LIMITS.fileBytes || total > PACKAGE_LIMITS.totalBytes)
      return refuse(`${at}: the package is over its size limit`);
    files.push({ path: file.path, bytes, kind: "file" });
  }
  return {
    candidateId: scalars.candidateId,
    revision: scalars.revision,
    bundle: freezePackage(scalars.manifestJson, files),
  };
}

const codeOf = (error: unknown) =>
  error instanceof FoundryError || error instanceof FoundryPackageError ? error.code : "INTERNAL_ERROR";
/** A package refusal's own fixed wording (which field, what to change); every other refusal stays a bare code. */
const reasonOf = (error: unknown) => (error instanceof FoundryPackageError ? error.message : undefined);
const denied = (error: unknown): CallCheck => {
  const code = codeOf(error);
  const reason = reasonOf(error);
  return { ok: false, message: `Foundry call refused: ${code}${reason ? ` (${reason})` : ""}`, data: { code } };
};
function refused(error: unknown): ToolOutput {
  const code = codeOf(error);
  const reason = reasonOf(error);
  return {
    content: JSON.stringify({ state: "REFUSED", code, ...(reason ? { reason } : {}) }),
    isError: true,
    data: { code },
  };
}
function output(value: unknown): ToolOutput {
  const status = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const failed =
    status?.state === "BLOCKED" ||
    ["FAIL", "FAILED", "CANCELLED", "UNKNOWN_OUTCOME", "ALREADY_ATTEMPTED"].includes(String(status?.outcome));
  return {
    content: JSON.stringify(value) ?? "null",
    ...(failed ? { isError: true } : {}),
    ...(status?.state === "EVALUATING" && status.pause ? { data: { pause: status.pause } } : {}),
  };
}

/** Native ToolSource only. An unavailable/disabled executor never falls back to host execution. */
export function createFoundryToolSource(deps: FoundryLifecycleDependencies & { enabled: boolean }): ToolSource {
  if (!deps.enabled)
    return {
      name: "foundry",
      async tools() {
        return [];
      },
    };
  const service = createFoundryService(deps);
  const lifecycle = createFoundryLifecycle(deps);

  async function applies(ctx: ToolContext): Promise<boolean> {
    const [message] = await deps.db
      .select({ body: schema.messages.body })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.orgId, ctx.orgId),
          eq(schema.messages.id, ctx.triggerMessageId),
          eq(schema.messages.channelId, ctx.channelId),
          isNull(schema.messages.deletedAt),
        ),
      );
    return !!message && receiptAppliesTo(message.body);
  }

  async function eligible(ctx: ToolContext, requiresApplicability = true, listing = false): Promise<void> {
    if (!deps.enabled) throw new FoundryError("AUTHORITY_DENIED");
    await foundryContext(deps.db, ctx);
    if (listing) {
      if (
        !deps.builderPolicy ||
        !(await deps.builderPolicy.sourceAllowed?.(ctx, "foundry")) ||
        !deps.builderPolicy.requiresModelBrain(ctx)
      )
        throw new FoundryError("BLOCKED_BUILDER_ISOLATION");
    } else if (!(await deps.builderPolicy?.protection(ctx))) throw new FoundryError("BLOCKED_BUILDER_ISOLATION");
    if (requiresApplicability && !(await applies(ctx))) throw new FoundryError("NOT_APPLICABLE");
  }

  function management<T>(
    name: string,
    description: string,
    scope: string,
    inputSchema: JsonSchema,
    parse: (input: unknown) => T,
    execute: (ctx: ToolContext, input: T) => Promise<unknown>,
    options: { sensitive?: boolean; requiresApplicability?: boolean } = {},
  ): ToolDefinition {
    return {
      name,
      description,
      scope,
      inputSchema,
      sensitive: !!options.sensitive,
      async checkCall(input, ctx) {
        try {
          parse(input);
          await eligible(ctx, !!options.requiresApplicability);
          return { ok: true };
        } catch (error) {
          return denied(error);
        }
      },
      async execute(input, ctx) {
        try {
          const args = parse(input);
          await eligible(ctx, !!options.requiresApplicability);
          return output(await execute(ctx, args));
        } catch (error) {
          return refused(error);
        }
      },
    };
  }

  const managementTools: ToolDefinition[] = [
    management<{ needKey: string }>(
      "propose_foundry_capability",
      "Check native reuse and draft a private receipt-normalizer candidate for this existing task.",
      "skills:read",
      proposalSchema,
      (input) => scalarArgs(input, proposalSchema),
      async (ctx, input) => {
        const proposed = await service.propose(ctx, input);
        return proposed.kind === "draft" ? { ...proposed, guidance: foundryDraftGuidance() } : proposed;
      },
      { requiresApplicability: true },
    ),
    management(
      "stage_foundry_package",
      "Freeze the supplied receipt-normalizer manifest and files (UTF-8 text, or base64 for non-text bytes) as inert private bytes. This does not run or activate code.",
      "skills:read",
      stageSchema,
      stageArgs,
      (ctx, input) => service.stage(ctx, input),
      { requiresApplicability: true },
    ),
    management<{ candidateId: string; digest: string }>(
      "evaluate_foundry_capability",
      "Request independent evaluation of an immutable digest through the configured qualified offline executor.",
      "sandbox:run",
      versionSchema,
      (input) => scalarArgs(input, versionSchema),
      (ctx, input) => lifecycle.evaluate(ctx, input),
    ),
    management<{ candidateId: string; digest: string; maxCalls: number; validUntil: string }>(
      "prepare_foundry_activation",
      "Resolve exact task, version, effects, evaluator and runtime parameters for a scoped activation approval.",
      "sandbox:run",
      prepareSchema,
      (input) => scalarArgs(input, prepareSchema),
      (ctx, input) => lifecycle.activationParameters(ctx, input),
    ),
    {
      ...management<FoundryActivationInput>(
        FOUNDRY_ACTIVATE_TOOL,
        "Activate the exact independently evaluated version for the approved native task, person, agent, expiry and call limit.",
        "sandbox:run",
        activationSchema,
        (input) => scalarArgs(input, activationSchema),
        (ctx, input) => lifecycle.activate(ctx, input),
        { sensitive: true },
      ),
      describe(input) {
        return {
          title: "Activate receipt normalizer for this task",
          detail:
            "Task " +
            String(input.taskId) +
            "; version " +
            String(input.versionDigest) +
            "; expires " +
            String(input.validUntil) +
            "; at most " +
            String(input.maxCalls) +
            " calls.",
        };
      },
    },
    management<{ bindingId: string }>(
      "run_foundry_canary",
      "Run the trusted canary for a scoped binding and record its verified outcome before ordinary reuse.",
      "sandbox:run",
      bindingSchema,
      (input) => scalarArgs(input, bindingSchema),
      (ctx, input) => lifecycle.runCanary(ctx, input.bindingId),
    ),
    management<{ bindingId: string }>(
      "revoke_foundry_capability",
      "Revoke this task's capability binding and invalidate pending or cached use through the native lifecycle.",
      "sandbox:run",
      bindingSchema,
      (input) => scalarArgs(input, bindingSchema),
      (ctx, input) => lifecycle.revoke(ctx, input.bindingId),
    ),
  ];

  function pureTool(binding: { candidateId: string; bindingId: string; digest: string }): ToolDefinition {
    const { candidateId, bindingId, digest } = binding;
    async function available(input: Record<string, unknown>, ctx: ToolContext) {
      if (!validateReceiptInput(input)) throw new FoundryError("SCHEMA_INVALID");
      await eligible(ctx);
      const current = await lifecycle.discover(ctx);
      if (
        !current.some(
          (item) => item.candidateId === candidateId && item.bindingId === bindingId && item.digest === digest,
        )
      )
        throw new FoundryError("AUTHORITY_DENIED");
    }
    return {
      name: foundryToolName(candidateId, digest),
      description:
        "Normalize synthetic task or run receipts into exact status counts and a token total. Notes remain inert data. Uses only this task's current approved version.",
      inputSchema: RECEIPT_INPUT_SCHEMA,
      reviewedCapability: { ...FOUNDRY_NATIVE_CONTRACT, versionDigest: digest },
      scope: "sandbox:run",
      external: true,
      async checkCall(input, ctx) {
        try {
          await available(input, ctx);
          return { ok: true };
        } catch (error) {
          return denied(error);
        }
      },
      async execute(input, ctx) {
        try {
          await available(input, ctx);
          return output(await lifecycle.execute(ctx, { bindingId, digest, input }));
        } catch (error) {
          return refused(error);
        }
      },
    };
  }

  return {
    name: "foundry",
    async tools(ctx) {
      try {
        await eligible(ctx, false, true);
        const applicable = await applies(ctx);
        const management = applicable
          ? managementTools
          : managementTools.filter(
              (tool) => tool.name !== "propose_foundry_capability" && tool.name !== "stage_foundry_package",
            );
        const bindings = applicable ? await lifecycle.discover(ctx) : [];
        return [...management, ...bindings.map(pureTool)];
      } catch {
        return [];
      }
    },
  };
}
