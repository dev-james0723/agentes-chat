import { describe, expect, test } from "bun:test";
import {
  isTregMcpEndpoint,
  prepareTregCall,
  TREG_MCP_URL,
  tregExecutor,
  tregReadTool,
  tregReceipt,
} from "../src/connectors/treg";

const context = {
  orgId: "workspace-1",
  agentId: "agent-1",
  runId: "run-1",
  toolUseId: "tool-call-1",
  connectionId: "connection-1",
};

describe("TREG dispatch policy", () => {
  test("only the HTTPS team endpoint receives the vendor policy", () => {
    expect(isTregMcpEndpoint(TREG_MCP_URL)).toBe(true);
    expect(isTregMcpEndpoint("https://treg.to/mcp")).toBe(true);
    for (const url of [
      "http://treg.to/mcp/",
      "https://treg.to.attacker.example/mcp/",
      "https://treg.to/mcp/v2/",
      "https://treg.to/mcp/?team=other",
      "https://user@treg.to/mcp/",
      "https://treg.to:8443/mcp/",
      "not a URL",
    ])
      expect(isTregMcpEndpoint(url)).toBe(false);
  });

  test("discovery and result reads are separate from dynamic executors and unknown tools", () => {
    for (const name of ["catalog_search", "catalog_get", "my_tools", "resources_list", "balance", "call_result"])
      expect(tregReadTool(name)).toBe(true);
    for (const name of ["call", "call_media", "feedback", "compare", "new_future_tool"])
      expect(tregReadTool(name)).toBe(false);
    expect(tregExecutor("call")).toBe(true);
    expect(tregExecutor("call_media")).toBe(true);
    expect(tregExecutor("catalog_get")).toBe(false);
  });

  test("caps are inserted into tool arguments, with immutable backend attribution and identity", () => {
    const input = {
      endpoint_id: "lever.postings.list",
      params: { site: "example", limit: 1 },
      idempotency_key: "model-chosen",
      headers: {
        AUTHORIZATION: "must-not-leave",
        "X-Treg-Token": "must-not-leave",
        "X-Treg-Meta": "workspace=somebody-else",
        "X-Treg-Org": "other",
        "Idempotency-Key": "another",
        "Accept-Language": "en",
      },
    };
    const out = prepareTregCall("call", input, context);
    expect(out.args.headers).toEqual({ "Accept-Language": "en", "X-Treg-Route-Max-Cost": "0" });
    expect(out.headers["X-Treg-Meta"]).toContain("workspace=workspace-1");
    expect(out.headers["X-Treg-Meta"]).toContain("agent=agent-1");
    expect(out.headers["X-Treg-Meta"]).not.toContain("somebody-else");
    expect(out.args.idempotency_key).not.toBe("model-chosen");
    expect(out.args.idempotency_key).toMatch(/^ac_[a-f0-9]{48}$/);
    expect(input.headers.AUTHORIZATION).toBe("must-not-leave");
    expect(out.capUsd).toBe(0);
  });

  test("ordinary and routine calls cannot claim a paid approval through model input", () => {
    const input = { endpoint_id: "paid.tool", approved: true, headers: { "x-treg-route-max-cost": "0.01" } };
    expect(() => prepareTregCall("call", input, context)).toThrow("approved");
    expect(() => prepareTregCall("call_media", input, { ...context, background: true })).toThrow("approved");
    expect(prepareTregCall("call", input, { ...context, approved: true }).capUsd).toBe(0.01);
  });

  test("duplicate or invalid cost ceilings cannot change what a person approved", () => {
    for (const cap of ["-1", "NaN", "Infinity", "1e6", "0.0000001", ""]) {
      expect(() =>
        prepareTregCall("call", { headers: { "X-Treg-Route-Max-Cost": cap } }, { ...context, approved: true }),
      ).toThrow();
    }
    expect(() =>
      prepareTregCall(
        "call",
        {
          headers: { "X-Treg-Route-Max-Cost": "0", "x-treg-route-max-cost": "100" },
        },
        { ...context, approved: true },
      ),
    ).toThrow();
  });

  test("idempotency is stable for the same native call and separated across context", () => {
    const run = (change = {}) => prepareTregCall("call", {}, { ...context, ...change }).args.idempotency_key;
    expect(run()).toBe(run());
    for (const change of [
      { orgId: "other-org" },
      { agentId: "other-agent" },
      { runId: "other-run" },
      { toolUseId: "other-call" },
      { connectionId: "other-connection" },
    ])
      expect(run(change)).not.toBe(run());
    expect(() => prepareTregCall("call", {}, { ...context, toolUseId: undefined })).toThrow("identity");
  });

  test("metadata contains only safe backend IDs and no email-shaped values", () => {
    const out = prepareTregCall("catalog_get", { endpoint_id: "x" }, { ...context, orgId: "person@example.com" });
    expect(out.headers["X-Treg-Meta"]).not.toContain("@");
    expect(out.headers["X-Treg-Meta"]).not.toContain("person");
    expect(out.args).toEqual({ endpoint_id: "x" });
    expect(out.capUsd).toBeNull();
  });

  test("Hub publication cannot spend through uncapped live checks", () => {
    for (const tool of ["hub_create", "hub_update"]) {
      expect(() => prepareTregCall(tool, { endpoint_id: "x" }, { ...context, approved: true })).toThrow("bounded cost");
    }
  });

  test("reported costs are evidence, and absent or malformed costs remain unknown", () => {
    expect(
      tregReceipt({
        content: "answer",
        data: { call_id: "call_123", cost_usd: 0.00099, status: 200, replayed: false },
      }),
    ).toEqual({ callId: "call_123", reportedCostUsd: 0.00099, reportedCostMicro: 990, status: 200, replayed: false });
    expect(tregReceipt({ content: JSON.stringify({ call_id: "call_2", cost_usd: null }) })).toEqual({
      callId: "call_2",
    });
    for (const value of [-1, "0", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(tregReceipt({ content: "", data: { cost_usd: value } })).toEqual({});
    }
    expect(tregReceipt({ content: "not JSON" })).toEqual({});
  });
});
