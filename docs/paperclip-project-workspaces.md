# Fixed project workspace migration

Use this only after migrations0263/0264 and a protocol66-or-newer native runner are deployed. Keep imported routines paused during review. Retain the original executor until its producer is deliberately switched; running both causes duplicate work.

1. Create a separate target copy and a complete snapshot inventory plus Git bundle. The source project metadata must name exactly one matching primary workspace. Retain source company/project/workspace IDs, both file digests and history provenance privately. Source and target must have the snapshot's initial Git HEAD. Do not copy hooks, credential stores or live application databases.
2. Through the normal local runner folder settings, grant only that target to its intended assignees. Never grant the source or a common parent. Each assignee must be owned by the same workspace owner, use Claude Code or Codex on that owner's paired Mac, and have an explicit model with fallback disabled.
3. From an owner terminal, run the existing native CLI:

```sh
agentes-runner paperclip-project register --confirm-local-owner \
  --owner-id OWNER --source-company COMPANY --source-project PROJECT --source-workspace WORKSPACE \
  --project-file /private/project.json --project-sha256 PROJECT_SHA256 \
  --snapshot-file /private/snapshot.json --snapshot-sha256 SNAPSHOT_SHA256 \
  --bundle-file /private/history.bundle --agent AGENT_UUID
```

Repeat `--agent` for each assignee. The three input files must be owned by the local account, readable only by it, and have no symlinked path. The output's `registration` object is the safe server certificate; the full native record stays under the runner home. Keep the printed binding ID and generation for reconciliation. A failed or uncertain registration must be inspected before retrying; do not replace a record.

4. While signed in as the workspace owner, POST exactly that `registration` object to `/api/app/organizations/ORG/paperclip-workspaces` through the normal session/CSRF API. This proves native grants/identity and pins the current models. It starts no routine or model work. GET the same route to read it back. Never transfer browser cookies to another host.
5. Create/adopt each paused routine mapping with its fixed `projectId`, `projectWorkspaceId` and `workspaceBindingId`, preserving the complete original description and PC1 marker. Review the mapping/native hashes, then use the existing compare-and-set prepare flow. Verify all seven routines' exact assignee, model, template, source IDs and target, and perform isolated transport/native/model canaries before enabling anything.
6. Revoke a server binding with POST `…/paperclip-workspaces/BINDING/disable` (JSON content type). It cannot be re-enabled; a new approval needs a new local registration. Locally, `agentes-runner paperclip-project remove --confirm-local-owner --binding BINDING` revokes the native record. Neither operation reverses work already started.

The explicit integration fixture is `scripts/paperclip-project-transport.ts`: run `server` in a disposable Linux container with only loopback port publication, then `mac http://127.0.0.1:PORT` on the Mac. It uses synthetic accounts and64temporary files, seven receipt-backed firings and real Mac child cwd evidence over real WebSocket transport. It calls no model service and touches no live pairing. Unit suites remain network-free.

A project override in an invocation is rejected. Definition-only import is not parity for a producer that chooses a project dynamically. Maintain those producers on the existing executor until separate approved bindings, snapshots, assignee grants, variables, idempotency/cursor and real canaries are ready.
