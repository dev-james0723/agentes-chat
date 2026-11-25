import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, signUp, type TestServer } from "./harness";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

test("Storage Guardian routes (ADR 0213): an owner reads the page, switches it off, and the queue starts empty", async () => {
  const server = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
  t = server;
  const owner = browser(server);
  await signUp(owner, "sg-owner@example.com");
  const { organization } = (await (
    await owner("/api/app/organizations", { json: { name: "Storage workspace" } })
  ).json()) as { organization: { id: string } };
  const base = `/api/app/organizations/${organization.id}/storage-guardian`;
  const view = await owner(base);
  expect(view.status).toBe(200);
  const body = (await view.json()) as { enabled: boolean; figures: { unlinked: number } };
  expect(body.enabled).toBe(true);
  expect(body.figures.unlinked).toBe(0);
  const off = await owner(`${base}/settings`, { method: "PUT", json: { enabled: false } });
  expect(off.status).toBe(200);
  expect(((await off.json()) as { enabled: boolean }).enabled).toBe(false);
  const review = await owner(`${base}/review`);
  expect(((await review.json()) as { items: unknown[] }).items).toEqual([]);
  // A folder on a computer the workspace doesn't have is refused.
  const scope = await owner(`${base}/scopes`, {
    json: { machineId: "0195f1a2-0000-7000-8000-000000000009", root: "scratch/" },
  });
  expect(scope.status).toBeGreaterThanOrEqual(400);
  const stranger = browser(server);
  await signUp(stranger, "sg-stranger@example.com");
  expect((await stranger(base)).status).toBeGreaterThanOrEqual(400);
});
