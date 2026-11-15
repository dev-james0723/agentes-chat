import { afterEach, expect, test } from "bun:test";
import { type SkillDetail, zip } from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const skill = (name: string) => `---\nname: ${name}\ndescription: Use for ${name}.\n---\n# ${name}`;

test("ZIP createOnly is parsed and cannot overwrite an existing skill", async () => {
  t = await createTestServer();
  const b = browser(t);
  await signUp(b, "owner@example.com");
  const { orgId } = await seedOrg(b);
  const path = `/api/app/organizations/${orgId}/skills/import`;
  const first = await b(path, {
    json: {
      zipBase64: Buffer.from(zip([["SKILL.md", skill("create-only-route")]])).toString("base64"),
      createOnly: true,
    },
  });
  expect(first.status).toBe(201);
  const created = (await first.json()) as { id: string; version: number; body: string };
  expect(created.version).toBe(1);
  const changed = `${skill("create-only-route")}\nThis must not overwrite the original.`;
  const duplicate = await b(path, {
    json: { zipBase64: Buffer.from(zip([["SKILL.md", changed]])).toString("base64"), createOnly: true },
  });
  expect(duplicate.status).toBe(409);
  const current = await b(`/api/app/organizations/${orgId}/skills/${created.id}`);
  expect(current.status).toBe(200);
  expect(await current.json()).toMatchObject({ id: created.id, version: 1, body: created.body });
});

test("body and description edits keep supporting files across versions; a new ZIP replaces them", async () => {
  t = await createTestServer();
  const b = browser(t);
  await signUp(b, "owner@example.com");
  const { orgId } = await seedOrg(b);
  const at = (path: string) => `/api/app/organizations/${orgId}/skills${path}`;
  const guide = "# Guide\nRead the supporting JSON before editing.\n";
  const options = '{"greeting":"Olá","enabled":true}\n';
  const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
  const script = "#!/bin/sh\nprintf 'fixture only\\n'\n";
  const markdown = `---
name: resource-patch
description: Use for resource-patch.
fixture: resource-preservation
---
# resource-patch
Read docs/guide.md.`;
  const imported = await b(at("/import"), {
    json: {
      zipBase64: Buffer.from(
        zip([
          ["SKILL.md", markdown],
          ["docs/guide.md", guide],
          ["data/options.json", options],
          ["assets/pixel.png", image],
          ["scripts/fixture.sh", script],
        ]),
      ).toString("base64"),
    },
  });
  expect(imported.status).toBe(201);
  const original = (await imported.json()) as SkillDetail;
  const expectedFiles: SkillDetail["files"] = [
    { path: "assets/pixel.png", size: image.byteLength, mime: "image/png", status: "stored" },
    { path: "data/options.json", size: Buffer.byteLength(options), mime: "application/json", status: "stored" },
    { path: "docs/guide.md", size: Buffer.byteLength(guide), mime: "text/markdown", status: "stored" },
    { path: "scripts/fixture.sh", size: Buffer.byteLength(script), mime: "text/x-shellscript", status: "script" },
  ];
  expect(original).toMatchObject({ version: 1, metadata: { fixture: "resource-preservation" } });
  expect(original.files).toEqual(expectedFiles);
  const readFile = async (path: string, version?: number) => {
    const response = await b(
      at(`/${original.id}/files/${encodeURIComponent(path)}${version === undefined ? "" : `?version=${version}`}`),
    );
    expect(response.status).toBe(200);
    return response.json();
  };
  const expectReadableFiles = async (version: number) => {
    for (const [path, mime, content] of [
      ["docs/guide.md", "text/markdown", guide],
      ["data/options.json", "application/json", options],
    ] as const) {
      expect(await readFile(path)).toEqual({ path, version, mime, content });
      expect(await readFile(path, 1)).toEqual({ path, version: 1, mime, content });
    }
  };
  await expectReadableFiles(1);

  const editedBody = "# Edited resource-patch\nKeep using docs/guide.md and data/options.json.";
  const bodyEdit = await b(at(`/${original.id}`), { method: "PATCH", json: { body: editedBody } });
  expect(bodyEdit.status).toBe(200);
  const bodyVersion = (await bodyEdit.json()) as SkillDetail;
  await expectReadableFiles(2);
  expect(bodyVersion).toMatchObject({
    id: original.id,
    version: 2,
    body: editedBody,
    description: original.description,
    metadata: original.metadata,
  });
  expect(bodyVersion.files).toEqual(expectedFiles);

  const editedDescription = "Use the edited resource fixture.";
  const descriptionEdit = await b(at(`/${original.id}`), {
    method: "PATCH",
    json: { description: editedDescription },
  });
  expect(descriptionEdit.status).toBe(200);
  const descriptionVersion = (await descriptionEdit.json()) as SkillDetail;
  await expectReadableFiles(3);
  expect(descriptionVersion).toMatchObject({
    version: 3,
    body: editedBody,
    description: editedDescription,
    metadata: original.metadata,
  });
  expect(descriptionVersion.files).toEqual(expectedFiles);

  const defaultEdit = await b(at(`/${original.id}`), { method: "PATCH", json: { defaultForNewAgents: true } });
  expect(defaultEdit.status).toBe(200);
  expect(await defaultEdit.json()).toMatchObject({ version: 3, defaultForNewAgents: true, files: expectedFiles });
  const current = await b(at(`/${original.id}`));
  expect(current.status).toBe(200);
  expect(await current.json()).toMatchObject({ version: 3, body: editedBody, files: expectedFiles });
  await expectReadableFiles(3);
  // These remain listed and kept, but the text-file endpoint never exposes binaries or scripts.
  for (const [path, status] of [
    ["assets/pixel.png", 400],
    ["scripts/fixture.sh", 404],
  ] as const) {
    expect((await b(at(`/${original.id}/files/${encodeURIComponent(path)}`))).status).toBe(status);
  }

  const replacementText = "Only the newly uploaded resource.";
  const replacement = await b(at("/import"), {
    json: {
      zipBase64: Buffer.from(
        zip([
          ["SKILL.md", skill("resource-patch")],
          ["replacement.md", replacementText],
        ]),
      ).toString("base64"),
    },
  });
  expect(replacement.status).toBe(201);
  const replaced = (await replacement.json()) as SkillDetail;
  expect(replaced).toMatchObject({ id: original.id, version: 4 });
  expect(replaced.files).toEqual([
    { path: "replacement.md", size: Buffer.byteLength(replacementText), mime: "text/markdown", status: "stored" },
  ]);
  expect(await readFile("replacement.md")).toEqual({
    path: "replacement.md",
    version: 4,
    mime: "text/markdown",
    content: replacementText,
  });
  expect((await b(at(`/${original.id}/files/${encodeURIComponent("docs/guide.md")}`))).status).toBe(404);
  expect(await readFile("docs/guide.md", 3)).toMatchObject({ version: 3, content: guide });
  expect(await readFile("data/options.json", 1)).toMatchObject({ version: 1, content: options });
});

/**
 * Fake GitHub: acme/skills' archive (two skills, deflated as codeload sends them) through codeload's redirect.
 * `limited`: every answer is GitHub limiting us.
 */
function fakeGithub() {
  const archive = zip([
    ["skills-main/skills/deploy/SKILL.md", skill("deploy")],
    ["skills-main/skills/review/SKILL.md", skill("review")],
  ]);
  const gh = { fetched: [] as string[], limited: false };
  const http = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    gh.fetched.push(url);
    if (gh.limited) return new Response("", { status: 429, headers: { "retry-after": "90" } });
    if (url.startsWith("https://github.com/acme/skills/archive/")) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://codeload.github.com/acme/skills/zip/abc" },
      });
    }
    if (url === "https://codeload.github.com/acme/skills/zip/abc") return new Response(archive);
    return new Response("404: Not Found", { status: 404 });
  }) as typeof fetch;
  return Object.assign(gh, { http });
}

test("a link holding several skills answers with them, the picked ones install, a skill's folder installs at once", async () => {
  const gh = fakeGithub();
  t = await createTestServer({ http: gh.http, resolveHost: async () => ["140.82.112.3"] });
  const b = browser(t);
  await signUp(b, "owner@example.com");
  const { orgId, agentId } = await seedOrg(b);
  const importing = (json: unknown) => b(`/api/app/organizations/${orgId}/skills/import`, { json });

  const listed = await importing({ url: "https://github.com/acme/skills" });
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual({
    choices: [
      { path: "skills/deploy", name: "deploy", description: "Use for deploy." },
      { path: "skills/review", name: "review", description: "Use for review." },
    ],
  });
  // From an agent's card (offer_install_skill): what installs goes on for that agent.
  const picked = await importing({
    url: "https://github.com/acme/skills",
    paths: ["skills/review"],
    forAgentId: agentId,
  });
  expect(picked.status).toBe(201);
  expect(((await picked.json()) as { skills: { name: string }[] }).skills.map((s) => s.name)).toEqual(["review"]);
  const its = (await (await b(`/api/app/organizations/${orgId}/agents/${agentId}/skills`)).json()) as {
    skills: { name: string; enabled: boolean }[];
  };
  expect(its.skills.map((s) => [s.name, s.enabled])).toEqual([["review", true]]);
  const one = await importing({ url: "https://github.com/acme/skills/tree/main/skills/deploy" });
  expect(one.status).toBe(201);
  expect(await one.json()).toMatchObject({ name: "deploy", version: 1, source: "url" });
  expect(gh.fetched.filter((u) => !/^https:\/\/(github|codeload\.github)\.com\//.test(u))).toEqual([]);

  // GitHub limiting this server: a 429 that says in how many minutes to try again.
  gh.limited = true;
  const limited = await importing({ url: "https://github.com/acme/skills" });
  expect(limited.status).toBe(429);
  expect(await limited.json()).toMatchObject({ error: { code: "github.limited", params: { count: 2 } } });
});

test("reading links is limited per person, 60 an hour, updating from a link included; a .zip isn't", async () => {
  const gh = fakeGithub();
  t = await createTestServer({ http: gh.http, resolveHost: async () => ["140.82.112.3"] });
  const b = browser(t);
  await signUp(b, "owner@example.com");
  const { orgId } = await seedOrg(b);
  const importing = (json: unknown) => b(`/api/app/organizations/${orgId}/skills/import`, { json });
  for (let i = 0; i < 60; i++) expect((await importing({ url: "https://github.com/acme/secret" })).status).toBe(400);
  const limited = await importing({ url: "https://github.com/acme/skills" });
  expect(limited.status).toBe(429);
  expect(await limited.json()).toMatchObject({ error: { code: "rate_limited" } });
  expect(gh.fetched.filter((u) => u.includes("acme/skills"))).toEqual([]);

  const upload = await importing({ zipBase64: Buffer.from(zip([["SKILL.md", skill("enviada")]])).toString("base64") });
  expect(upload.status).toBe(201);
  const { id } = (await upload.json()) as { id: string };
  expect((await b(`/api/app/organizations/${orgId}/skills/${id}/reimport`, { json: {} })).status).toBe(429);
});

test("a private repository is read through the workspace's GitHub connection, never in an answer; members may not", async () => {
  const token = "ghp_fake_connection_token";
  const archive = zip([
    ["acme-private-abc/skills/deploy/SKILL.md", skill("deploy")],
    ["acme-private-abc/skills/review/SKILL.md", skill("review")],
  ]);
  const sent: { url: string; auth: string | null }[] = [];
  // github.com hides acme/private; the API's zipball answers only the connection's token.
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const auth = new Headers(init?.headers).get("authorization");
    sent.push({ url, auth });
    if (url === "https://api.github.com/repos/acme/private/zipball" && auth === `Bearer ${token}`) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://codeload.github.com/acme/private/z?t=1" },
      });
    }
    if (url === "https://codeload.github.com/acme/private/z?t=1") return new Response(archive);
    return new Response("404: Not Found", { status: 404 });
  }) as typeof fetch;
  t = await createTestServer({ http, resolveHost: async () => ["140.82.112.3"] });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const url = "https://github.com/acme/private";
  const importing = (b: typeof owner, json: unknown) => b(`/api/app/organizations/${orgId}/skills/import`, { json });

  const hidden = await importing(owner, { url });
  expect(hidden.status).toBe(400);
  expect(await hidden.json()).toMatchObject({
    error: { code: "github.repo_missing", params: { repo: "acme/private", connection: "none", app: false } },
  });

  const connected = await owner(`/api/app/organizations/${orgId}/connectors`, {
    json: { connector: "github", apiKey: token },
  });
  expect(connected.status).toBe(201);
  const listed = await importing(owner, { url, list: true });
  expect(listed.status).toBe(200);
  const body = await listed.text();
  expect(JSON.parse(body)).toEqual({
    choices: [
      { path: "skills/deploy", name: "deploy", description: "Use for deploy." },
      { path: "skills/review", name: "review", description: "Use for review." },
    ],
    via: "github",
  });
  expect(body).not.toContain("ghp_");
  const picked = await importing(owner, { url, paths: ["skills/deploy"] });
  expect(picked.status).toBe(201);
  const installed = await picked.text();
  expect(JSON.parse(installed)).toMatchObject({ skills: [{ name: "deploy", sourceVia: "github" }] });
  expect(installed).not.toContain("ghp_");
  expect(sent.filter((s) => s.auth && !s.url.startsWith("https://api.github.com/"))).toEqual([]);

  // Installing skills is what lets a person read through the workspace's GitHub.
  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  const before = sent.length;
  expect((await importing(member, { url, list: true })).status).toBe(403);
  expect(sent.length).toBe(before);
});

test("updating from its link: text applies and is undone, a new script waits for approval, updating by itself is a switch", async () => {
  const repo: Record<string, string> = { "skills-main/deploy/SKILL.md": skill("deploy") };
  const http = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://github.com/acme/skills/archive/"))
      return new Response(null, {
        status: 302,
        headers: { location: "https://codeload.github.com/acme/skills/zip/abc" },
      });
    if (url === "https://codeload.github.com/acme/skills/zip/abc") return new Response(zip(Object.entries(repo)));
    return new Response("404: Not Found", { status: 404 });
  }) as typeof fetch;
  t = await createTestServer({ http, resolveHost: async () => ["140.82.112.3"] });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const at = (path: string) => `/api/app/organizations/${orgId}/skills${path}`;
  const made = await owner(at("/import"), { json: { url: "https://github.com/acme/skills/tree/main/deploy" } });
  const { id } = (await made.json()) as { id: string };

  expect(await (await owner(at(`/${id}/update`), { json: {} })).json()).toMatchObject({ status: "unchanged" });
  repo["skills-main/deploy/SKILL.md"] = `${skill("deploy")}\n\nMore.`;
  expect(await (await owner(at(`/${id}/update`), { json: {} })).json()).toMatchObject({
    status: "updated",
    skill: { version: 2, lastUpdate: { fromVersion: 1 } },
  });
  expect(await (await owner(at(`/${id}/update/undo`), { json: {} })).json()).toMatchObject({
    version: 3,
    lastUpdate: null,
  });

  repo["skills-main/deploy/run.sh"] = "echo hi";
  // The route of apps released before `/update`: the same gate.
  expect(await (await owner(at(`/${id}/reimport`), { json: {} })).json()).toMatchObject({
    version: 3,
    pendingUpdate: { scripts: ["run.sh"] },
  });
  expect(await (await owner(at(`/${id}/update`), { json: {} })).json()).toMatchObject({
    status: "waiting",
    scripts: ["run.sh"],
    skill: { version: 3, pendingUpdate: { scripts: ["run.sh"], dismissed: false } },
  });
  expect(await (await owner(at(`/${id}`))).json()).toMatchObject({
    pending: { files: [{ path: "run.sh", before: null, after: "echo hi", large: false }], base: null },
    changes: [],
  });
  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  expect((await member(at(`/${id}/update/approve`), { json: {} })).status).toBe(403);
  expect((await member(at(`/${id}/update/reopen`), { json: {} })).status).toBe(403);
  expect((await member(at(`/${id}`), { method: "PATCH", json: { autoUpdate: true } })).status).toBe(403);
  // Kept out, then Desfazer: it waits again.
  expect(await (await owner(at(`/${id}/update/dismiss`), { json: {} })).json()).toMatchObject({
    pendingUpdate: { dismissed: true },
  });
  expect(await (await owner(at(`/${id}/update/reopen`), { json: {} })).json()).toMatchObject({
    pendingUpdate: { dismissed: false, dismissedAt: null },
  });
  expect(await (await owner(at(`/${id}/update/approve`), { json: {} })).json()).toMatchObject({
    status: "updated",
    skill: { version: 4, pendingUpdate: null, lastUpdate: { waited: true } },
  });
  expect(await (await owner(at(`/${id}`), { method: "PATCH", json: { autoUpdate: true } })).json()).toMatchObject({
    autoUpdate: true,
  });
});

test("Agentes melhoram as skills sozinhos: on by default, who manages agents turns it off, a skill's own switch wins", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  const settings = `/api/app/organizations/${orgId}/skill-settings`;

  expect(await (await member(settings)).json()).toEqual({ agentsImprove: true });
  expect((await member(settings, { method: "PUT", json: { agentsImprove: false } })).status).toBe(403);
  const off = await owner(settings, { method: "PUT", json: { agentsImprove: false } });
  expect([off.status, await off.json()]).toEqual([200, { agentsImprove: false }]);
  expect(await (await member(settings)).json()).toEqual({ agentsImprove: false });

  const created = await owner(`/api/app/organizations/${orgId}/skills`, {
    json: { name: "deploy", description: "Deploys.", body: "# deploy" },
  });
  const { id, agentsImprove } = (await created.json()) as { id: string; agentsImprove: boolean | null };
  expect(agentsImprove).toBeNull();
  const patch = (b: typeof owner, json: unknown) =>
    b(`/api/app/organizations/${orgId}/skills/${id}`, { method: "PATCH", json });
  expect((await patch(member, { agentsImprove: true })).status).toBe(403);
  const on = await patch(owner, { agentsImprove: true });
  expect(((await on.json()) as { agentsImprove: boolean; version: number }).agentsImprove).toBe(true);
  const back = await patch(owner, { agentsImprove: null });
  expect(await back.json()).toMatchObject({ agentsImprove: null, version: 1 });
});
