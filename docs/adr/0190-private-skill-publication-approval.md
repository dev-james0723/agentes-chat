# 0190 — Read-only native proof support for private skill publication

Status: **isolated support candidate; not registered, wired, deployed, or a privacy repair**. Base: `aed5b6fe2d72f18d22986a0c9edc05529e7e781f`. Shared runtime owner owns the native issuer, Gateway/view/event/notification integration after JAM-151. ADR0188 promotion and B2 one-shot read-source audience contracts are separate boundaries.

## Decision and scope

Reuse the installed Gateway's `actionHash`, native `approvals` row and decision flow, existing run/message/channel membership ACLs, skill assignment/scope/load receipts. No new dependency, table, controller, index export, hook, tool registration, network or model invocation. New code is only `skill-publication-approval.ts`; it performs database reads only. Tests use existing isolated PGlite fixtures, real Gateway `load_skill` / `expand`, and `decideApproval` with fake inference, never live native records.

A direct private request and `ownWords`, membership, `asked.decides`, model metadata, or ordinary `ctx.approved` are **not** consent to share its content. `prepareSkillPublication` returns only an opaque fingerprint/expiry descriptor, never an approval, raw draft, source text or native write. `verifySkillPublicationApproval` reads an actual DB row by ID and checks native facts; even its positive result has `mayPublish:false`, `wiring:NOT_IMPLEMENTED`. It does not claim execution or consume approval. Nothing here makes the existing broad approval UI safe.

## Exact future wire contract (not accepted by today's ordinary Gateway)

The future privacy-aware issuer must construct an exact server-owned `approvals.params` value:

```ts
{
  contract: "skill-publication-v1",
  input: { name: string, body: string },
  publication: {
    orgId, agentId, runId, channelId, threadRootId, triggerMessageId,
    toolUseId, ownerUserId, skillId,
    baseVersion, baseHash, resourcesHash, sourcesHash, audienceHash,
    purpose: "publish_to_org_skill_library",
    sourceCoverage: "current-dm-and-recorded-expand-only",
    issuedAt, expiresAt
  }
}
```

Hashes use existing `sha256(canonicalJson(...))`, except body/message text hashes use exact text bytes via `sha256(text)`. `resourcesHash` is the hash of `[]` **only when the current version has no resources**; metadata is never called a content hash. `sourcesHash` hashes native source descriptors `{kind,id,hash,channels}`, sorted by ID. Trigger text and accepted context item content/version/sourceIds/agentId/scopeType/scopeId are bound. `audienceHash` hashes `{channelId,ownerUserId,agentId}` after verifying exactly those two native DM participants. `issuedAt` is the native approval row's `createdAt`, `expiresAt` exactly ten minutes later. Final actionHash uses existing `{tool:"update_skill",scope:"skills:read",connectionId:null,params:<whole envelope>}`. The envelope is private server data; **do not pass it to existing broad list/get/event/notification paths**, and do not submit it as today's update_skill model input.

Required native row fields additionally bind the same org/agent/run/channel/thread/toolUse identity, owner/requester, scope and purpose; no mission/routine/ahead/always fields. Approvers are exactly `{userIds:[ownerUserId],label:"source owner",requestedBy:ownerUserId,requesterDecides:true,required:true}`. A verified row must be approved by that actual owner, not a cover, have a valid decision time, be unexpired and unconsumed (`executedAt:null`), and match both recomputed actionHash and current independently derived facts. A seeded approved boolean is not accepted as an API input; local positive tests use actual native `decideApproval` to populate the DB decision.

The future issuer must use this same contract or explicitly version it; ordinary workflow must not assume wrapped params until the source owner adds a dedicated parsing/issuing branch and protected views. The module deliberately exports no raw-envelope builder. Public/manual UI import/edit/shared994 behavior is not intercepted or modified.

## Supported bounded facts and fail-closed limits

The native run/agent/channel/trigger IDs must match; the agent must be active, scope/assignment enabled, target unlocked and own-agent ownership honored. A successful native load receipt must name the current target ID/version. A supported source is a fresh single-human/single-agent DM, top-level direct human trigger, no other DM messages, no pending steering/background/bridge/brain session, and **null transcript**. Non-null transcript is deferred because complete preloaded/private source propagation cannot be proven at this baseline. The single source person must still hold manage_agents and native source-channel read access.

Successful recorded native `expand` reads can add an active, unsuperseded same-DM context item authored by that same person, scoped to the same agent or shared, with only the direct trigger as its source. The complete current item content must appear in the recorded result; otherwise defer. This is bounded current-fact evidence, not a full historical source ledger. Other tools, errors/incomplete reads, external marks, more owners, unknown provenance, resources or file edits defer without any content-bearing approval/proposal. Full resource-byte hashing and arbitrary context provenance remain unsupported rather than manufactured from metadata. UI approval cannot fix unknown rights or represent all-owner consent with today's OR approvers.

`mayViewSkillPublicationApproval` is an **opt-in predicate**, not an endpoint mutation: only the same currently entitled source owner with matching bounded native facts can pass. It fails closed for stale target/source facts; general historical view availability remains an integration concern. Existing `required:true` narrows decisions but does not stop other approve_actions admins reading native list/get, and native events fan out full params. A local synthetic test explicitly demonstrates that existing broad view still exposes the marker while this predicate denies the outside admin.

## Required integration before any publication

1. Source owner must first make native list/get/card/action/count/event/inbox/push/email/digest/trail readers enforce the source audience, with generic content-free channel cards; no raw model why/title or broader consultation/routine/card-merge delivery. Then create the native private one-shot approval before changeSkillAsAgent or proposal persistence.
2. Dedicated Gateway branch must require this exact share-purpose approval regardless never/remembered/own-job rules, with schema/security/read checks before asking. Generic approvals, ctx.approved, OR multi-owner approvals, or permission changes cannot substitute.
3. Re-read/revalidate approved row and current state, then transactionally claim approved/unexpired/unconsumed row and lock/compare target base before exact skill write. This module does not implement a claim/write transaction, CAS, retries, source taint propagation or exactly-once effects. Existing `writeSkillVersion` does not perform a base-version comparison.
4. Re-run the source privacy counterexample, issuer/view/stream/notification holdouts, races and UI preview acceptance. Script/low-trust/additional review rules still apply independently after source disclosure consent.

## Verification

TDD first: opaque-preparation and native-proof positive requirements failed against defer stubs; stale-load and invalid UUID holdouts then failed for their intended reasons before repair. Targeted test receipts, exact argv/exit codes, source hashes and patch are supplied with the execution results. Tests explicitly retain DONE/verified-helper versus integrated privacy qualification distinctions; no live approval/model/server/permissions/deploy changes are performed.


## Follow-up — current native context ACL and scope drift

Independent review of initial candidate `18fd6e34f7bd49c07c83da2b4f9d8bfdd819d518` confirmed a P2: changing a read item's scope from agent to another real person's scope left the helper fingerprint/proof/view valid, while actual native Gateway `expand` denied it. Content, version, sourceIds and channelIds remained unchanged. The original 13 green tests were insufficient and are retained as history, not evidence that this boundary was already correct.

The follow-up reuses exported native `personMayRead(item, owner, agentId)` on the current DB item in the shared facts reader used by preparation, proof and opt-in view. It does not duplicate a broader ACL or use an admin/model boolean to grant source access. Each context-item hash now also binds `agentId`, `scopeType` and `scopeId`: even a scope change that is still native-readable invalidates the prior exact approval. The wire envelope fields/tag are unchanged; the unregistered candidate's context source hash formula is strengthened, so old seeded context-source approval hashes are intentionally stale. No real issuer or production contract was registered.

Focused red: 14 PASS / 2 FAIL against the original source. The denial regression evaluates all helpers before a denied native probe appends any error step. Its actual native-owner decision and pre-drift allowed expand are retained. A fresh unchanged owner-person scope is a positive native-readable control, and an agent-to-owner-person scope change remains readable but must change the fingerprint and invalidate old proof/view. Local fake-inference fixtures only; `mayPublish:false`, no shared issuer/UI/Gateway/notification/claim-write implementation or full privacy-repair claim.
