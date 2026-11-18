#!/usr/bin/env node
// Turns a full local CI receipt into a published `local-ci/full` status, in three separate steps so each can be run
// by a different party:
//
//   review  --receipt R --reviewer ID --evidence REVIEW_FILE      (the reviewer's file must name the head and result)
//   sign    --receipt R --logs DIR --key ED25519_PRIVATE_PEM --out ENVELOPE  (rechecks every step's log hash)
//   verify|publish --envelope E --config PUBLISHER_CONFIG_JSON [--branch B]
//
// The signer's public key comes only from the publisher's own config (`signerPublicKeyPath`, owner-only file), never
// from the command line, so a key made up on the spot cannot sign a receipt that gets published. `publish`
// re-verifies everything through local-ci-status.mjs (exact head, all 22 steps passed, fresh receipt, signature,
// approval) and posts nothing unless that passes.
//
// Trust this gives: a status only for an exact head, after 22 named steps whose logs match their hashes, signed by the
// one pinned key, with the remote branch still at that head. Trust it does not give: proof that the reviewer is a
// different party from the signer, or that the signer's machine is honest. That rests on who holds the signer key.
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishAttestedStatus, signReceipt, verifyAttestation } from "./local-ci-status.mjs";

const REVIEW_RESULTS = new Set(["approved", "changes_requested"]);

/** A review file says `head: <40-hex>` and `result: approved|changes_requested` on their own lines. */
export function reviewFromFile(text, head) {
  if (!/^[a-f0-9]{40}$/.test(head ?? "")) throw Error("invalid_head");
  const named = new RegExp(`^head:\\s*${head}\\s*$`, "m").test(text);
  const result = /^result:\s*(approved|changes_requested)\s*$/m.exec(text)?.[1];
  if (!named) throw Error("review_does_not_name_this_head");
  if (!result) throw Error("review_result_missing");
  return result;
}

export function attachReview(receipt, { reviewer, result, evidenceSha256, at = new Date().toISOString() }) {
  if (!REVIEW_RESULTS.has(result)) throw Error("invalid_review_result");
  if (typeof reviewer !== "string" || !reviewer.trim()) throw Error("reviewer_required");
  if (!/^[a-f0-9]{64}$/.test(evidenceSha256 ?? "")) throw Error("review_evidence_required");
  return { ...receipt, review: { sha: receipt.head, independent: true, result, reviewer, evidenceSha256, at } };
}

function ownerOnlyFile(path) {
  const st = statSync(path);
  if (!st.isFile() || (st.mode & 0o077) !== 0) throw Error("key_file_permissions_unsafe");
}

/** Every step's log is where the receipt says and has the hash the receipt says. */
export function checkLogs(receipt, logsDir) {
  if (receipt?.mode !== "full" || receipt?.sourceVerified !== true)
    throw Error("receipt_not_full_or_source_unverified");
  for (const step of receipt.steps ?? []) {
    const hash = createHash("sha256")
      .update(readFileSync(join(logsDir, `${step.id}.log`)))
      .digest("hex");
    if (hash !== step.logSha256) throw Error(`log_hash_mismatch:${step.id}`);
  }
}

export function pinnedPublicKey(config) {
  if (typeof config?.signerPublicKeyPath !== "string" || !isAbsolute(config.signerPublicKeyPath))
    throw Error("signer_public_key_not_pinned");
  ownerOnlyFile(config.signerPublicKeyPath);
  const key = createPublicKey(readFileSync(config.signerPublicKeyPath));
  if (key.asymmetricKeyType !== "ed25519") throw Error("signer_key_not_ed25519");
  return key;
}

function privateKeyFrom(path) {
  const st = statSync(path);
  if (!st.isFile() || (st.mode & 0o077) !== 0) throw Error("signer_key_permissions_unsafe");
  const key = createPrivateKey(readFileSync(path));
  if (key.asymmetricKeyType !== "ed25519") throw Error("signer_key_not_ed25519");
  return key;
}

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, "");
    if (!k || argv[i + 1] === undefined) throw Error("expected --name value pairs");
    o[k] = argv[i + 1];
  }
  return o;
}

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const write = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`, { mode: 0o600 });

async function main([cmd, ...rest]) {
  const o = args(rest);
  if (cmd === "review") {
    const receipt = read(o.receipt);
    const text = readFileSync(o.evidence, "utf8");
    const result = reviewFromFile(text, receipt.head);
    const evidenceSha256 = createHash("sha256").update(text).digest("hex");
    write(o.receipt, attachReview(receipt, { reviewer: o.reviewer, result, evidenceSha256 }));
    return { reviewed: true, result };
  }
  if (cmd === "sign") {
    const receipt = read(o.receipt);
    checkLogs(receipt, o.logs);
    const envelope = signReceipt(receipt, privateKeyFrom(o.key));
    write(o.out, envelope);
    return { signed: true, head: envelope.receipt.head };
  }
  if (cmd === "verify" || cmd === "publish") {
    if (o["public-key"]) throw Error("public_key_comes_from_config_only");
    const envelope = read(o.envelope);
    const config = read(o.config);
    const publicKey = pinnedPublicKey(config);
    const head = envelope.receipt?.head;
    const repository = envelope.receipt?.repo;
    const verdict = verifyAttestation(envelope, publicKey, { repository, head });
    if (cmd === "verify" || !verdict.ok) return { ...verdict, head, repository };
    return publishAttestedStatus(envelope, { publicKey, repository, head, branch: o.branch, config });
  }
  throw Error("usage: local-ci-attest.mjs review|sign|verify|publish …");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok === false ? 1 : 0);
    },
    (e) => {
      console.error(String(e?.message ?? e));
      process.exit(1);
    },
  );
}
