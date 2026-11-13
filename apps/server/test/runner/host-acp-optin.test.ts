import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createHostAcpOptIn,
  hostAcpVerified,
  markHostAcpVerified,
  readHostAcpOptIn,
  removeHostAcpOptIn,
} from "../../runner/host-acp-optin";

describe("local host ACP opt-in", () => {
  test("binds local uid and pairing, requires private directory and creates no credential files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "host-acp-test-"));
    try {
      const binding = {
        server: "https://example.test",
        orgId: "org-12345678",
        machineId: "machine-12345678",
        mode: "user" as const,
        platform: "darwin",
        phones: false,
      };
      expect(readHostAcpOptIn(root, binding)).toBeNull();
      const created = createHostAcpOptIn(root, binding);
      expect(created.id).toMatch(/^[a-f0-9-]{36}$/);
      expect(readHostAcpOptIn(root, binding)).toEqual(created);
      expect(() => markHostAcpVerified(root, binding, "wrong-id")).toThrow();
      const verified = markHostAcpVerified(root, binding, created.id);
      expect(typeof verified.verifiedAt).toBe("number");
      expect(readHostAcpOptIn(root, binding)).toEqual(verified);
      expect(hostAcpVerified(verified, verified.verifiedAt!)).toBe(true);
      expect(hostAcpVerified(verified, verified.verifiedAt! + 24 * 60 * 60 * 1000)).toBe(false);
      expect(hostAcpVerified(verified, verified.verifiedAt! - 1)).toBe(false);
      expect(hostAcpVerified(created)).toBe(false);
      expect(readHostAcpOptIn(root, { ...binding, machineId: "machine-different" })).toBeNull();
      expect(readHostAcpOptIn(root, { ...binding, orgId: "org-different" })).toBeNull();
      expect(readHostAcpOptIn(root, { ...binding, server: "https://elsewhere.test" })).toBeNull();
      expect(readHostAcpOptIn(root, { ...binding, phones: true })).toBeNull();
      expect(() => createHostAcpOptIn(root, binding)).toThrow();
      expect(removeHostAcpOptIn(root, binding)).toBe(true);
      expect(readHostAcpOptIn(root, binding)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("rejects broad directory permissions and symlink metadata", () => {
    const root = mkdtempSync(path.join(tmpdir(), "host-acp-test-"));
    const b = {
      server: "https://example.test",
      orgId: "org-12345678",
      machineId: "machine-12345678",
      mode: "user" as const,
      platform: "darwin",
      phones: false,
    };
    try {
      chmodSync(root, 0o755);
      expect(() => createHostAcpOptIn(root, b)).toThrow();
      chmodSync(root, 0o700);
      symlinkSync("/dev/null", path.join(root, "host-acp-optin.json"));
      expect(readHostAcpOptIn(root, b)).toBeNull();
      expect(() => createHostAcpOptIn(root, b)).toThrow();
      expect(removeHostAcpOptIn(root, b)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
