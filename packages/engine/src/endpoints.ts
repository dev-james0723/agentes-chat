import { OutboundAddressError } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, isNull, schema } from "@agenteschat/db";
import {
  customModelId,
  ENDPOINT_STYLES,
  type EndpointStyle,
  listEndpointModels,
  type ModelInfo,
  parseCustomModel,
  setCustomModels,
  type ToolSpec,
} from "@agenteschat/providers";
import { z } from "zod";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { NotFoundError, ValidationError } from "./errors";
import type { ModelGateway } from "./gateway";
import { assertPublicHttpsUrl, publicHttpsFetch, type ResolveHost } from "./net-guard";
import { requirePermission } from "./organizations";
import { isAgentesCloud } from "./telemetry";
import { redactCredentials } from "./tool-detail";

/**
 * A workspace's own model endpoint (ADR 0146): an OpenAI- or Anthropic-compatible server (a gateway, Ollama, vLLM,
 * LM Studio, LiteLLM), kept as a `custom` credential whose options hold its address, API style and the models an
 * admin chose, each with optional prices. Its models are `custom:<credentialId>:<model>`, offered only to its
 * workspace.
 */
export type StoredEndpoint = schema.StoredEndpoint;
export type EndpointModel = StoredEndpoint["models"][number];
export type EndpointCheck = {
  model: string;
  check: NonNullable<EndpointModel["check"]>;
  error?: string;
  structuredOutputCheck?: "ok" | "failed";
  structuredOutputError?: string;
};

/** How this server reaches endpoints people type. */
export interface EndpointNet {
  /** Addresses on this server's network and http allowed (`MODEL_ENDPOINTS_PRIVATE`). */
  allowPrivate: boolean;
  /** Outbound HTTP (tests: a fake); absent: plain `fetch` when private addresses are allowed, else the guarded one. */
  fetch?: typeof fetch;
  resolveHost?: ResolveHost;
}

export const MAX_ENDPOINT_MODELS = 30;
const MODEL_ID = /^[\w.:/@+-]{1,200}$/;
/** What a key-less server (a local Ollama) is sent: the SDKs need some key. */
export const ENDPOINT_NO_KEY = "none";

/**
 * Whether this server lets endpoints be private or http: `MODEL_ENDPOINTS_PRIVATE`, else everywhere but the Cloud and
 * a server open to anyone's sign-up (`ALLOW_SIGNUP`), where a stranger's workspace would reach this server's network.
 */
export const allowsPrivateEndpoints = (config: {
  MODEL_ENDPOINTS_PRIVATE?: boolean;
  PUBLIC_URL: string;
  ALLOW_SIGNUP?: boolean;
}) => config.MODEL_ENDPOINTS_PRIVATE ?? (!isAgentesCloud(config.PUBLIC_URL) && !config.ALLOW_SIGNUP);

/** The fetch endpoint calls go through: private addresses allowed or not, every request checked at connect time. */
export const endpointFetch = (net: EndpointNet): typeof fetch =>
  net.fetch ?? (net.allowPrivate ? fetch : publicHttpsFetch());

/**
 * An endpoint's address as its API's SDK takes it: no query, no trailing slash, and the path the SDK adds left out
 * (`/chat/completions`; `/v1` or `/v1/messages` for Anthropic's). Without `allowPrivate`, https only and every
 * address the host resolves to public (`assertPublicHttpsUrl`; each call is checked again when it connects).
 */
export async function endpointAddress(raw: string, style: EndpointStyle, net: EndpointNet): Promise<string> {
  if (!ENDPOINT_STYLES.includes(style)) throw new ValidationError("Pick the API the server speaks", "endpoint.style");
  let url: URL;
  if (net.allowPrivate) {
    try {
      url = new URL(raw.trim());
    } catch {
      throw new ValidationError("Invalid address", "url.invalid");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new ValidationError("Use an https:// or http:// address", "url.invalid");
    if (url.username || url.password)
      throw new ValidationError("The address can't have a user or password", "url.credentials");
  } else url = await assertPublicHttpsUrl(raw.trim(), net.resolveHost);
  const path = url.pathname.replace(/\/+$/, "");
  const base =
    style === "anthropic" ? path.replace(/\/v1(\/messages)?$/, "") : path.replace(/\/chat\/completions$/, "");
  return `${url.origin}${base}`;
}

/** The models an admin chose, checked: ids that look like one, names and prices that make sense, at most 30. */
export function cleanEndpointModels(models: EndpointModel[], previous: EndpointModel[] = []): EndpointModel[] {
  if (models.length === 0) throw new ValidationError("Choose at least one model", "endpoint.no_models");
  if (models.length > MAX_ENDPOINT_MODELS)
    throw new ValidationError(`At most ${MAX_ENDPOINT_MODELS} models`, "endpoint.too_many_models");
  const seen = new Set<string>();
  return models.map((m) => {
    const id = m.id.trim();
    if (!MODEL_ID.test(id)) throw new ValidationError(`"${id}" doesn't look like a model id`, "endpoint.model_id");
    if (seen.has(id)) throw new ValidationError(`${id} is listed twice`, "endpoint.model_id");
    seen.add(id);
    const label = m.label?.trim().slice(0, 120);
    const p = m.prices;
    if (p && Object.values(p).some((v) => !Number.isSafeInteger(v) || v < 0))
      throw new ValidationError("Prices can't be negative", "endpoint.prices");
    const before = previous.find((o) => o.id === id);
    const check = before?.check;
    const structuredOutput = m.structuredOutput ?? before?.structuredOutput;
    if (structuredOutput !== undefined && typeof structuredOutput !== "boolean")
      throw new ValidationError("Structured output must be on or off", "endpoint.structured_output");
    // Model edits require a new check; never accept or carry a schema verification result into the new configuration.
    return {
      id,
      ...(label ? { label } : {}),
      ...(p ? { prices: p } : {}),
      ...(check ? { check } : {}),
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    };
  });
}

/** Key/model configuration changes invalidate every prior or in-flight schema verification. */
export const invalidateEndpointVerification = (endpoint: StoredEndpoint): StoredEndpoint => ({
  ...endpoint,
  verification: { configurationId: crypto.randomUUID() },
  models: endpoint.models.map(({ structuredOutputCheck: _check, ...m }) => m),
});

const endpointVerified = (endpoint: StoredEndpoint | undefined) =>
  Boolean(
    endpoint?.verification?.configurationId &&
      endpoint.verification.attemptId &&
      endpoint.verification.completedAttemptId === endpoint.verification.attemptId,
  );

/** Schema calls require both an admin opt-in and the server's passing check, never a model-name or URL guess. */
const infoOf = (endpointName: string, m: EndpointModel, verified: boolean): ModelInfo => ({
  provider: "custom",
  label: m.label ?? m.id,
  endpoint: endpointName,
  prices: m.prices ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  ...(m.prices ? {} : { unpriced: true as const }),
  serverSideFallback: false,
  ...(verified && m.structuredOutput === true && m.structuredOutputCheck === "ok"
    ? {}
    : { structuredOutput: false as const }),
});

/**
 * Puts an organization's endpoint models in memory (`setCustomModels`) from its live `custom` credentials, read like
 * other credential rows (cached 30 s, dropped by `invalidateDefaults` on any key change).
 */
export async function loadEndpointModels(db: Executor, orgId: string) {
  const rows = (await caches.credentials.getOrLoad(`${orgId}:endpoints`, () =>
    db
      .select({
        id: schema.providerCredentials.id,
        label: schema.providerCredentials.label,
        options: schema.providerCredentials.options,
      })
      .from(schema.providerCredentials)
      .where(
        and(
          eq(schema.providerCredentials.orgId, orgId),
          eq(schema.providerCredentials.provider, "custom"),
          isNull(schema.providerCredentials.revokedAt),
        ),
      ),
  )) as { id: string; label: string; options: { endpoint?: StoredEndpoint } }[];
  setCustomModels(
    orgId,
    Object.fromEntries(
      rows.flatMap((r) =>
        (r.options.endpoint?.models ?? []).map(
          (m) => [customModelId(r.id, m.id), infoOf(r.label, m, endpointVerified(r.options.endpoint))] as const,
        ),
      ),
    ),
  );
}

/**
 * What an endpoint lists, before anything is stored (admins): its cleaned address and model ids, or the reason it
 * listed none (the admin then types ids by hand). An address this server won't reach is refused.
 */
export async function listEndpoint(
  db: Database,
  actorId: string,
  orgId: string,
  input: { style: EndpointStyle; baseURL: string; apiKey?: string },
  net: EndpointNet,
): Promise<{ baseURL: string; models: { id: string; label?: string }[]; error?: string }> {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  const baseURL = await endpointAddress(input.baseURL, input.style, net);
  try {
    const models = await listEndpointModels(
      { style: input.style, baseURL },
      input.apiKey?.trim() || ENDPOINT_NO_KEY,
      endpointFetch(net),
    );
    return { baseURL, models };
  } catch (error) {
    if (error instanceof OutboundAddressError)
      throw new ValidationError("This address points to an internal network", "url.internal");
    return { baseURL, models: [], error: redactCredentials(error instanceof Error ? error.message : String(error)) };
  }
}

/** The tool the test call asks for: agents work through tools, so a model that never calls one can't do their work. */
const CHECK_TOOL: ToolSpec = {
  name: "report_status",
  description: "Report that the connection works.",
  inputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
};
const CHECK_TIMEOUT_MS = 60_000;
const CHECK_OUTPUT = z.strictObject({
  status: z.literal("ok"),
  details: z.strictObject({ supported: z.literal(true), modes: z.array(z.literal("schema")).length(1) }),
});
const CHECK_OUTPUT_SCHEMA = z.toJSONSchema(CHECK_OUTPUT);

/** A small, strict nested fixture: syntactically valid JSON alone is insufficient. */
async function checkStructuredOutput(
  gateway: Pick<ModelGateway, "complete">,
  orgId: string,
  credentialId: string,
  model: string,
): Promise<Pick<EndpointCheck, "structuredOutputCheck" | "structuredOutputError">> {
  try {
    const r = await gateway.complete({
      orgId,
      kind: "summary",
      model: customModelId(credentialId, model),
      system: "Check schema-constrained output. Return only the JSON object requested.",
      messages: [{ role: "user", content: 'Return {"status":"ok","details":{"supported":true,"modes":["schema"]}}.' }],
      outputSchema: CHECK_OUTPUT_SCHEMA,
      maxTokens: 256,
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (r.stopReason !== "end_turn" || !CHECK_OUTPUT.safeParse(JSON.parse(r.text)).success)
      throw new Error("The endpoint did not return the complete required JSON schema");
    return { structuredOutputCheck: "ok" };
  } catch (error) {
    return {
      structuredOutputCheck: "failed",
      structuredOutputError: redactCredentials(error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * One small call per model of an endpoint (admins), through the Model Gateway (recorded as a `summary` call with its
 * tokens and cost): `ok` when it called the tool it was asked to, `no_tools` when it answered without, `failed` with
 * the server's words. Models explicitly opted in to structured output also get a separate strict nested schema
 * call (256 output tokens, 60 seconds). Only that call's passing result enables schema use. Both calls are metered.
 */
export async function checkEndpoint(
  db: Database,
  gateway: Pick<ModelGateway, "complete">,
  actorId: string,
  orgId: string,
  credentialId: string,
): Promise<EndpointCheck[]> {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  const where = and(
    eq(schema.providerCredentials.id, credentialId),
    eq(schema.providerCredentials.orgId, orgId),
    eq(schema.providerCredentials.provider, "custom"),
    isNull(schema.providerCredentials.revokedAt),
  );
  const endpoint = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(schema.providerCredentials).where(where).for("update");
    const current = row?.options.endpoint;
    if (!row || !current) throw new NotFoundError("Credential not found");
    const next: StoredEndpoint = {
      ...current,
      models: current.models.map(({ structuredOutputCheck: _check, ...m }) => m),
      verification: {
        configurationId: current.verification?.configurationId ?? crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
      },
    };
    await tx
      .update(schema.providerCredentials)
      .set({ options: { ...row.options, endpoint: next } })
      .where(where);
    return next;
  });
  // A recheck is pending, so a previous passing result cannot advertise readiness during it.
  caches.credentials.delete(`${orgId}:${credentialId}`);
  caches.credentials.delete(`${orgId}:endpoints`);
  const results = await Promise.all(
    endpoint.models.map(async (m): Promise<EndpointCheck> => {
      let result: EndpointCheck;
      try {
        const r = await gateway.complete({
          orgId,
          kind: "summary",
          model: customModelId(credentialId, m.id),
          system: "You are checking that a connection works.",
          messages: [{ role: "user", content: "Call the report_status tool with ok set to true." }],
          maxTokens: 1024,
          tools: [CHECK_TOOL],
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        });
        result = { model: m.id, check: r.content.some((b) => b.type === "tool_use") ? "ok" : "no_tools" };
      } catch (error) {
        result = {
          model: m.id,
          check: "failed",
          error: redactCredentials(error instanceof Error ? error.message : String(error)),
        };
      }
      return m.structuredOutput === true
        ? { ...result, ...(await checkStructuredOutput(gateway, orgId, credentialId, m.id)) }
        : result;
    }),
  );
  const applied = await db.transaction(async (tx) => {
    // Both configuration and attempt must still match: equal model ids/configurations do not imply equal checks.
    const [current] = await tx.select().from(schema.providerCredentials).where(where).for("update");
    const currentEndpoint = current?.options.endpoint;
    if (!current || !currentEndpoint) throw new NotFoundError("Credential not found");
    const verification = currentEndpoint.verification;
    if (
      !verification ||
      verification.configurationId !== endpoint.verification?.configurationId ||
      verification.attemptId !== endpoint.verification?.attemptId
    )
      return false;
    const models = currentEndpoint.models.map((m) => {
      const result = results.find((r) => r.model === m.id);
      return {
        ...m,
        ...(result ? { check: result.check } : {}),
        ...(m.structuredOutput === true && result?.structuredOutputCheck
          ? { structuredOutputCheck: result.structuredOutputCheck }
          : {}),
      };
    });
    await tx
      .update(schema.providerCredentials)
      .set({
        options: {
          ...current.options,
          endpoint: {
            ...currentEndpoint,
            models,
            verification: { ...verification, completedAttemptId: verification.attemptId },
          },
        },
      })
      .where(where);
    return true;
  });
  caches.credentials.delete(`${orgId}:${credentialId}`);
  caches.credentials.delete(`${orgId}:endpoints`);
  return applied
    ? results
    : results.map((result) => ({
        ...result,
        ...(result.structuredOutputCheck
          ? {
              structuredOutputCheck: "failed" as const,
              structuredOutputError: "This check was superseded by a configuration change or newer check",
            }
          : {}),
      }));
}

/** Changes which models an endpoint offers and their prices (admins); checks are run again by the caller. */
export async function updateEndpointModels(
  db: Database,
  actorId: string,
  orgId: string,
  credentialId: string,
  models: EndpointModel[],
) {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  const where = and(
    eq(schema.providerCredentials.id, credentialId),
    eq(schema.providerCredentials.orgId, orgId),
    eq(schema.providerCredentials.provider, "custom"),
    isNull(schema.providerCredentials.revokedAt),
  );
  const { next, label } = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(schema.providerCredentials).where(where).for("update");
    const endpoint = row?.options.endpoint;
    if (!row || !endpoint) throw new NotFoundError("Credential not found");
    const next = invalidateEndpointVerification({ ...endpoint, models: cleanEndpointModels(models, endpoint.models) });
    await tx
      .update(schema.providerCredentials)
      .set({ options: { ...row.options, endpoint: next } })
      .where(where);
    return { next, label: row.label };
  });
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "credential.models_changed",
    target: { type: "credential", id: credentialId },
    details: { provider: "custom", label, models: next.models.map((m) => m.id) },
  });
  caches.credentials.delete(`${orgId}:${credentialId}`);
  caches.credentials.delete(`${orgId}:endpoints`);
  return next;
}

/** The organizations of `userId` that have a live endpoint: whose models `GET /models` adds for them. */
export async function endpointOrgsOf(db: Executor, userId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ orgId: schema.providerCredentials.orgId })
    .from(schema.providerCredentials)
    .innerJoin(
      schema.organizationMembers,
      and(
        eq(schema.organizationMembers.orgId, schema.providerCredentials.orgId),
        eq(schema.organizationMembers.userId, userId),
      ),
    )
    .where(and(eq(schema.providerCredentials.provider, "custom"), isNull(schema.providerCredentials.revokedAt)));
  return rows.map((r) => r.orgId);
}

/** Prices as people type them (US dollars per million tokens) in nano-USD per token; a cache price absent is the input's. */
export function endpointPricesFromUsd(p: { input: number; output: number; cacheRead?: number; cacheWrite?: number }) {
  const nano = (usd: number) => Math.round(usd * 1000);
  return {
    input: nano(p.input),
    output: nano(p.output),
    cacheRead: nano(p.cacheRead ?? p.input),
    cacheWrite: nano(p.cacheWrite ?? p.input),
  };
}

/** Nano-USD per token back in US dollars per million tokens. */
export const endpointPricesToUsd = (p: NonNullable<EndpointModel["prices"]>) => ({
  input: p.input / 1000,
  output: p.output / 1000,
  cacheRead: p.cacheRead / 1000,
  cacheWrite: p.cacheWrite / 1000,
});

/** What the pickers add for an endpoint's model (ADR 0146): whose credential, its name, and whether it has prices. */
export function pickerEndpoint(id: string, info: ModelInfo) {
  const credentialId = parseCustomModel(id)?.credentialId;
  if (!credentialId) return {};
  return {
    endpoint: { credentialId, name: info.endpoint ?? "" },
    ...(info.unpriced ? { unpriced: true } : {}),
  };
}
