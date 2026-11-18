#!/usr/bin/env node
// Turns a full local CI receipt into a published `local-ci/full` status, in three separate steps so each can be run
// by a different party:
//
//   review  --receipt R --reviewer ID --result approved|changes_requested --evidence PATH   (the independent reviewer)
//   sign    --receipt R --key ED25519_PRIVATE_PEM --out ENVELOPE                             (the signer)
//   publish --envelope E --public-key ED25519_PUBLIC_PEM --config APP_CONFIG_JSON --branch B (the publisher)
//
// `publish` re-verifies everything through local-ci-status.mjs (exact head, all 22 steps passed, fresh receipt,
// signature, independent approval) and posts nothing unless that passes.
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishAttestedStatus, signReceipt, verifyAttestation } from "./local-ci-status.mjs";

const REVIEW_RESULTS = new Set(["approved", "changes_requested"]);

export function attachReview(receipt, { reviewer, result, evidenceSha256, at = new Date().toISOString() }) {
  if (!REVIEW_RESULTS.has(result)) throw Error("invalid_review_result");
  if (typeof reviewer !== "string" || !reviewer.trim()) throw Error("reviewer_required");
  if (!/^[a-f0-9]{64}$/.test(evidenceSha256 ?? "")) throw Error("review_evidence_required");
  return { ...receipt, review: { sha: receipt.head, independent: true, result, reviewer, evidenceSha256, at } };
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
    const evidenceSha256 = createHash("sha256").update(readFileSync(o.evidence)).digest("hex");
    write(o.receipt, attachReview(read(o.receipt), { reviewer: o.reviewer, result: o.result, evidenceSha256 }));
    return { reviewed: true };
  }
  if (cmd === "sign") {
    const envelope = signReceipt(read(o.receipt), privateKeyFrom(o.key));
    write(o.out, envelope);
    return { signed: true, head: envelope.receipt.head };
  }
  if (cmd === "verify" || cmd === "publish") {
    const envelope = read(o.envelope);
    const publicKey = createPublicKey(readFileSync(o["public-key"]));
    const head = envelope.receipt?.head;
    const repository = envelope.receipt?.repo;
    const verdict = verifyAttestation(envelope, publicKey, { repository, head });
    if (cmd === "verify" || !verdict.ok) return { ...verdict, head, repository };
    const config = read(o.config);
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
