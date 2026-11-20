import { expect, test } from "bun:test";
import { connectorOAuthApps, loadConfig, redactConfig } from "./index";

test("Colab is optional, needs both OAuth values and redacts the secret", () => {
  const valid = { DATABASE_URL: "postgres://u:p@localhost:5432/db", AGENTES_SECRET: "x".repeat(48) };
  expect(connectorOAuthApps(loadConfig(valid)).colab).toBeUndefined();
  expect(connectorOAuthApps(loadConfig({ ...valid, CONNECTOR_COLAB_CLIENT_ID: "test-client" })).colab).toBeUndefined();
  const config = loadConfig({
    ...valid,
    CONNECTOR_COLAB_CLIENT_ID: "test-client",
    CONNECTOR_COLAB_CLIENT_SECRET: "test-colab-secret",
  });
  expect(connectorOAuthApps(config).colab).toEqual({ clientId: "test-client", clientSecret: "test-colab-secret" });
  expect(JSON.stringify(redactConfig(config))).not.toContain("test-colab-secret");
});
