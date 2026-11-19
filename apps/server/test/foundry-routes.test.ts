import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

// Its session check covers only its own /organizations/* paths; github-app.test.ts shows a public
// route mounted after it (GitHub's callback) still answers without one.
test("the Foundry opt-in asks for a session", async () => {
  const orgId = crypto.randomUUID();
  const issueId = crypto.randomUUID();
  const res = await browser(t)(`/api/app/organizations/${orgId}/issues/${issueId}/foundry-runs`, {
    json: { requestId: crypto.randomUUID() },
  });
  expect(res.status).toBe(401);
});
