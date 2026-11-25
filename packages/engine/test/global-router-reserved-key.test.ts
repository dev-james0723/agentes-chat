import { afterEach, expect, test } from "bun:test";
import { noPlatformCredentials } from "@agenteschat/adapters";
import { schema } from "@agenteschat/db";
import { createFakeProvider } from "@agenteschat/providers/testing";
import { createAgent } from "../src/agents";
import { enableCaches } from "../src/cache";
import { createCredential } from "../src/credentials";
import { sha256 } from "../src/crypto";
import { createModelGateway } from "../src/gateway";
import { createOrganization } from "../src/organizations";
import { type Fixture, setup } from "./fixtures";

/**
 * A key the Global Model Router owns is reserved for it: no ordinary, unbudgeted call may spend it, found either by
 * this workspace's credential row or by the secret's fingerprint from any workspace. The check rides in the gateway's
 * one fresh protection statement (budget-queries bounds that), so it is proven here on its own.
 */
let f: Fixture;
afterEach(async () => {
  enableCaches(false);
  await f?.close();
  f = undefined as unknown as Fixture;
});
const MODEL = "claude-sonnet-5-5";
const KEY = "sk-ant-synthetic-global-router-reserved";

function gatewayWith(provider: ReturnType<typeof createFakeProvider>) {
  return createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: provider },
  });
}

async function reserve(orgId: string, credentialId: string, fingerprint: string) {
  await f.db.insert(schema.globalRouterAccounts).values({
    orgId,
    provider: "deepseek",
    lane: "direct_api",
    entitlement: "free_only",
    credentialId,
    credentialVersion: "v1",
    credentialFingerprint: fingerprint,
    approvedBy: "test",
  });
}

async function agentOn(orgId: string, apiKey: string) {
  const credential = await createCredential(f.db, f.keyWrapper, f.owner.id, orgId, {
    provider: "anthropic",
    label: "ordinary key",
    apiKey,
  });
  const agent = await createAgent(
    f.db,
    f.owner.id,
    orgId,
    {
      name: "Plain",
      handle: `plain${orgId.slice(0, 6)}`,
      role: "Developer",
      instructions: "Answer.",
      credentialId: credential.id,
    },
    { model: MODEL },
  );
  return { credential, agent };
}

const ask = (
  gateway: ReturnType<typeof gatewayWith>,
  orgId: string,
  agent: Awaited<ReturnType<typeof agentOn>>["agent"],
) =>
  gateway.stream({
    orgId,
    agentId: agent.id,
    agent,
    system: "sys",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 100,
    onDelta: () => {},
  });

test("a credential row the router holds in this workspace is refused for an ordinary call", async () => {
  f = await setup();
  const { credential, agent } = await agentOn(f.org.id, KEY);
  await reserve(f.org.id, credential.id, "fingerprint-of-another-version");
  const provider = createFakeProvider();
  await expect(ask(gatewayWith(provider), f.org.id, agent)).rejects.toMatchObject({
    reason: "reserved_credential",
  });
  expect(provider.calls).toHaveLength(0);
});

test("the same secret copied into another workspace is refused by its fingerprint", async () => {
  f = await setup();
  await reserve(f.org.id, crypto.randomUUID(), sha256(KEY));
  const { organization: other } = await createOrganization(f.db, f.owner.id, { name: "Copied-key organization" });
  const { agent } = await agentOn(other.id, KEY);
  const provider = createFakeProvider();
  await expect(ask(gatewayWith(provider), other.id, agent)).rejects.toMatchObject({
    reason: "reserved_credential",
  });
  expect(provider.calls).toHaveLength(0);
});

test("a key the router doesn't hold still answers", async () => {
  f = await setup();
  await reserve(f.org.id, crypto.randomUUID(), sha256("sk-ant-some-other-router-key"));
  const { agent } = await agentOn(f.org.id, KEY);
  const provider = createFakeProvider();
  const result = await ask(gatewayWith(provider), f.org.id, agent);
  expect(result.text).toContain("hello");
  expect(provider.calls).toHaveLength(1);
});
