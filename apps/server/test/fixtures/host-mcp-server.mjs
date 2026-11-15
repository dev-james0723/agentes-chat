// Authored test server. No installed provider, phone, credentials or network.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "host-fixture", version: "1" }, { capabilities: { tools: {} } });
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/2ioAAAAASUVORK5CYII=";
server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (process.argv.includes("catalog-secret-error")) throw new Error("synthetic-provider-key-must-not-escape");
  return {
    tools: Array.from({ length: 70 }, (_, i) => ({
      name: `tool_${i}`,
      description: `fixture ${i}`,
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: i === 0 },
    })),
  };
});
server.setRequestHandler(CallToolRequestSchema, async (r) => {
  if (r.params.arguments?.hang) await new Promise((resolve) => setTimeout(resolve, 30000));
  if (r.params.arguments?.exit) process.exit(2);
  return {
    content: [
      { type: "text", text: "pixels from real stdio" },
      { type: "image", mimeType: "image/png", data: png },
    ],
  };
});
await server.connect(new StdioServerTransport());
