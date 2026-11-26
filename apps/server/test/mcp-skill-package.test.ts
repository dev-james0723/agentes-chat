import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { zip } from "@agenteschat/engine";
import { callTool, connectApp, mcp } from "./ai-apps";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

test("the pinned package, native files, durable receipt and conditional assignment refer to the same skill", async () => {
  const archive = zip([
    ["repo-a/tools/check/SKILL.md", "---\nname: check\ndescription: Check totals.\n---\nCheck totals."],
    ["repo-a/tools/check/docs/example.md", "Expected example.\n"],
    ["repo-a/other/SKILL.md", "---\nname: separate\ndescription: Other skill.\n---\nOther."],
  ]);
  let reads = 0;
  const http = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://github.com/acme/repo/archive/")) {
      reads++;
      return new Response(archive);
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const t = await createTestServer({ http, resolveHost: async () => ["140.82.112.3"] });
  server = t;
  const b = browser(t);
  await signUp(b, "owner@example.com");
  const { orgId, agentId } = await seedOrg(b);
  const { access } = await connectApp(t, b, orgId, {
    name: "Package fixture",
    access: "manage",
    scope: "read write manage",
  });
  const read = await connectApp(t, b, orgId, { name: "Read only", access: "read", scope: "read" });
  const tools = (await (await mcp(t, read.access, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as {
    result: { tools: { name: string }[] };
  };
  expect(tools.result.tools.map((row) => row.name)).not.toContain("install_github_skill");
  expect(tools.result.tools.map((row) => row.name)).not.toContain("assign_skill");
  const args = {
    source_url: `https://github.com/acme/repo/tree/${"a".repeat(40)}`,
    path: "tools/check",
    expected_name: "check",
    agent_ids: [agentId],
    idempotency_key: "fixture-1",
  };
  const install = (extra: Record<string, unknown> = {}) =>
    callTool(t, access, "install_github_skill", { ...args, ...extra });
  expect((await install({ agent_ids: [crypto.randomUUID()] })).isError).toBe(true);
  expect((await install({ source_url: "https://github.com/acme/repo/tree/main" })).isError).toBe(true);
  expect(reads).toBe(0);
  const member = await joinByInvitation(t, b, orgId, "member@example.com");
  const memberApp = await connectApp(t, member, orgId, {
    name: "Member fixture",
    access: "manage",
    scope: "read write manage",
  });
  expect((await callTool(t, memberApp.access, "install_github_skill", args)).isError).toBe(true);
  expect(reads).toBe(0);
  expect((await install({ path: "other" })).isError).toBe(true);
  expect((await install({ path: "absent" })).isError).toBe(true);
  const first = await install();
  expect(first.isError, JSON.stringify(first.content)).not.toBe(true);
  const id = String(first.structuredContent?.id);
  expect(first.structuredContent).toMatchObject({
    id,
    name: "check",
    version: 1,
    path: "tools/check",
    agent_ids: [agentId],
    replayed: false,
  });
  expect(first.structuredContent?.source_hash).toMatch(/^[0-9a-f]{64}$/);
  const file = await b(`/api/app/organizations/${orgId}/skills/${id}/files/${encodeURIComponent("docs/example.md")}`);
  expect(await file.json()).toMatchObject({ content: "Expected example.\n", version: 1 });
  const count = reads;
  expect((await install()).structuredContent).toEqual({ ...first.structuredContent, replayed: true });
  expect((await install({ path: "other" })).isError).toBe(true);
  expect(reads).toBe(count);
  expect((await install({ idempotency_key: "second" })).isError).toBe(true);
  const [skill] = await t.db.select().from(schema.skills).where(eq(schema.skills.id, id));
  if (!skill) throw Error("No skill");
  const guard = {
    expected_version: 1,
    expected_body_sha256: new Bun.CryptoHasher("sha256").update(skill.body).digest("hex"),
  };
  await t.db.update(schema.agentSkills).set({ enabled: false }).where(eq(schema.agentSkills.skillId, id));
  expect((await install()).isError).toBe(true);
  const assign = (extra: Record<string, unknown> = {}) =>
    callTool(t, access, "assign_skill", { skill_id: id, agent_ids: [agentId], ...guard, ...extra });
  expect(
    (await callTool(t, memberApp.access, "assign_skill", { skill_id: id, agent_ids: [agentId], ...guard })).isError,
  ).toBe(true);
  expect((await assign({ expected_body_sha256: "0".repeat(64) })).isError).toBe(true);
  expect((await assign({ expected_version: 2 })).isError).toBe(true);
  expect((await assign()).structuredContent).toMatchObject({ id, version: 1, agent_ids: [agentId] });
  expect((await assign()).structuredContent).toMatchObject({ id, version: 1 });
  const update = (extra: Record<string, unknown> = {}) =>
    callTool(t, access, "update_skill", { skill: id, body: "New totals.", ...guard, ...extra });
  expect((await update({ skill: "check" })).isError).toBe(true);
  expect((await update({ expected_body_sha256: "0".repeat(64) })).isError).toBe(true);
  expect((await update()).isError).not.toBe(true);
  expect((await update()).isError).toBe(true);
  expect((await assign()).isError).toBe(true);
});
