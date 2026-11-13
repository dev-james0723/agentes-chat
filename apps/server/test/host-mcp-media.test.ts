import { expect, test } from "bun:test";
import type { RunnerFrame } from "@agenteschat/adapters";
import { parseServerFrame } from "@agenteschat/adapters/machine-protocol";
import { handleMcpMessage } from "../runner/mcp";

const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/2ioAAAAASUVORK5CYII=";
test("native MCP bridge returns actual image blocks, never an image placeholder", async () => {
  const reply = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report", arguments: {} } },
    async () => ({ ok: true, text: "pixels", images: [{ data, mediaType: "image/png" }] }),
  );
  expect(reply).toMatchObject({
    result: {
      content: [
        { type: "text", text: "pixels" },
        { type: "image", mimeType: "image/png", data },
      ],
    },
  });
});
test("host MCP rejects malformed media at its output boundary while native PDF frames remain supported", async () => {
  const { hostMcpOutput } = await import("@agenteschat/adapters");
  expect(() => hostMcpOutput({ content: [{ type: "image", mimeType: "image/png", data: "invalid!" }] })).toThrow();
  expect(
    parseServerFrame(
      JSON.stringify({
        type: "mcp.result",
        callId: "one",
        ok: true,
        text: "document",
        images: [{ mediaType: "application/pdf", name: "fixture.pdf", data: "JVBERi0xLjQ=" }],
      }),
    ),
  ).not.toBeNull();
});
test("real bridge frame-to-IPC result preserves exact pixels without opening a listener", async () => {
  const { McpBridge } = await import("../runner/mcp");
  const frames: RunnerFrame[] = [];
  const b = new McpBridge({
    socketPath: "unused-no-listener",
    task: () => ({ token: "synthetic-token", missionId: "fixture", running: true }),
    callTimeoutMs: 1000,
  });
  b.attach((f) => frames.push(f));
  const pending = b.handle({ taskId: "fixture", token: "synthetic-token", tool: "report", args: {} });
  while (!frames.length) await Bun.sleep(1);
  const frame = parseServerFrame(
    JSON.stringify({
      type: "mcp.result",
      callId: (frames[0] as Extract<RunnerFrame, { type: "mcp.call" }>).callId,
      ok: true,
      text: "pixels",
      images: [{ mediaType: "image/png", data }],
    }),
  );
  if (!frame || frame.type !== "mcp.result") throw new Error("image frame refused");
  b.result(frame);
  expect(await pending).toMatchObject({ ok: true, images: [{ mediaType: "image/png", data }] });
  await b.close();
});
test("typed media validates image signatures and safely handles a large base64 body", async () => {
  const { hostMcpOutput } = await import("@agenteschat/adapters");
  expect(() => hostMcpOutput({ content: [{ type: "image", mimeType: "image/png", data: "AAAA" }] })).toThrow();
  const large = data.slice(0, 16) + "AAAA".repeat(200000);
  expect(
    hostMcpOutput({ content: [{ type: "image", mimeType: "image/png", data: large }] }).images?.[0]?.data.length,
  ).toBe(large.length);
});
test("machine wire rejects malformed or confused media while preserving named PDF resources", () => {
  const frame = (images: unknown) =>
    parseServerFrame(JSON.stringify({ type: "mcp.result", callId: "one", ok: true, text: "media", images }));
  const pdf = { mediaType: "application/pdf", name: "fixture.pdf", data: "JVBERi0xLjQ=" };
  expect(frame([pdf])).not.toBeNull();
  const nativeLargePdf = pdf.data.slice(0, 8) + "AAAA".repeat((6 * 1024 * 1024) / 4);
  expect(frame([{ ...pdf, data: nativeLargePdf }])).not.toBeNull();
  expect(frame([{ mediaType: "image/png", data }])).not.toBeNull();
  for (const images of [
    {},
    [{ mediaType: "image/png", data: "invalid!" }],
    [{ mediaType: "image/png", data: "AAAA" }],
    [{ ...pdf, data }],
    [{ mediaType: "image/png", data: pdf.data }],
    [{ ...pdf, data: "AAAA" }],
    [{ ...pdf, extra: "extension" }],
    [{ ...pdf, name: 1 }],
    Array.from({ length: 21 }, () => pdf),
  ])
    expect(frame(images)).toBeNull();
});
