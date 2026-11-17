import { expect, test } from "bun:test";
import { createFoundryRpcClient, createFoundryRpcHandler } from "../src/foundry-rpc";
const token = "a".repeat(64);
const request = (path: string, body = "{}", secret = token) => new Request(`http://localhost/internal/foundry/${path}`, {
  method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body });
test("private RPC refuses wrong credentials, unknown methods, browser origins and non-JSON before control", async () => {
  let calls = 0; const handle = createFoundryRpcHandler({ token, methods: { inspect: async input => { calls++; return input; } } });
  expect((await handle(request("inspect", "{}", "wrong"))).status).toBe(401);
  expect((await handle(request("constructor"))).status).toBe(404);
  const browser = request("inspect"); browser.headers.set("Origin", "http://localhost");
  expect((await handle(browser)).status).toBe(403);
  const bad = request("inspect"); bad.headers.set("Content-Type", "text/plain");
  expect((await handle(bad)).status).toBe(415); expect(calls).toBe(0);
  const ok = await handle(request("inspect", '{"value":"inert"}')); expect(ok.status).toBe(200); expect(await ok.json()).toEqual({ value: "inert" }); expect(calls).toBe(1);
});
test("bounded streamed input and sanitized errors cannot expose secrets", async () => {
  const handle = createFoundryRpcHandler({ token, maxBytes: 128, methods: { inspect: async () => { throw new Error("private-secret-path"); } } });
  expect((await handle(request("inspect", "x".repeat(129)))).status).toBe(413);
  const error = await handle(request("inspect")); expect(error.status).toBe(503); expect(await error.text()).not.toContain("private-secret-path");
});
test("client pins operator endpoint, does not redirect bearer credentials, and bounds results", async () => {
  for (const url of ["file:///tmp/secret", "http://example.com/", "http://user:password@localhost/", "http://localhost/?token=x"])
    expect(() => createFoundryRpcClient({ url, token })).toThrow();
  const handle = createFoundryRpcHandler({ token, methods: { echo: async input => input } });
  const client = createFoundryRpcClient({ url: "http://localhost/internal/foundry/", token,
    fetch: (async (url: string | Request | URL, init?: RequestInit) => { expect(init?.redirect).toBe("error"); expect(init?.credentials).toBe("omit"); return handle(new Request(url instanceof Request ? url.url : String(url), init)); }) as unknown as typeof fetch });
  expect(await client("echo", { a: "b" })).toEqual({ a: "b" });
  await expect(client("../escape", {})).rejects.toThrow();
  const huge = createFoundryRpcClient({ url: "http://localhost/", token, maxBytes: 128,
    fetch: (async () => new Response(JSON.stringify({ data: "x".repeat(500) }))) as unknown as typeof fetch });
  await expect(huge("echo", {})).rejects.toThrow();
});
