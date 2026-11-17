import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateFoundryQualificationStore } from "../src/foundry-private-qualification";
const paths: string[] = [];
afterEach(() => { for (const p of paths.splice(0)) rmSync(p, { force: true, recursive: true }); });
const identity = { runnerId: "runner", runtimeDigest: "a".repeat(64), profileDigest: "b".repeat(64) };
function fixture() {
 const d = mkdtempSync(join(tmpdir(), "foundry-proof-test-")); paths.push(d); const p = join(d, "proof.json");
 writeFileSync(p, JSON.stringify({ schema: "foundry-qualification/1", attestation: { ...identity, authorityId: "operator", revoked: false } }), { mode: 0o600 });
 return { d, p, store: createPrivateFoundryQualificationStore({ filename: p, authorityId: "operator" }) };
}
test("qualification store reads fresh operator-owned proof and does not cache a revocation", async () => {
 const f = fixture(); expect(await f.store.read(identity)).toMatchObject({ revoked: false });
 writeFileSync(f.p, JSON.stringify({ schema: "foundry-qualification/1", attestation: { ...identity, authorityId: "operator", revoked: true } }));
 expect(await f.store.read(identity)).toMatchObject({ revoked: true });
 expect(await f.store.read({ ...identity, profileDigest: "c".repeat(64) })).toBeNull();
});
test("shared, missing, oversized or symlinked qualification files fail closed", async () => {
 const f = fixture(); chmodSync(f.p, 0o644); expect(await f.store.read(identity)).toBeNull();
 chmodSync(f.p, 0o600); writeFileSync(f.p, "x".repeat(65537)); expect(await f.store.read(identity)).toBeNull();
 rmSync(f.p); expect(await f.store.read(identity)).toBeNull();
 const target = join(f.d, "other"); writeFileSync(target, "{}", { mode: 0o600 }); symlinkSync(target, f.p);
 expect(await f.store.read(identity)).toBeNull();
});
