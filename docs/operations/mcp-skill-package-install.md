# Install or assign one skill through MCP

These mutations use a workspace-bound OAuth `manage` grant and the consenting person's current `manage_agents` permission.

| Tool | Input | Successful result |
| --- | --- | --- |
| `install_github_skill` | `source_url`, `path`, `expected_name`, `agent_ids`, `idempotency_key` | `id`, `name`, `version`, `source_url`, `path`, `source_hash`, sorted `agent_ids`, `idempotency_key`, `replayed` |
| `assign_skill` | `skill_id`, `agent_ids`, `expected_version`, `expected_body_sha256` | `id`, `name`, `version`, `body_sha256`, sorted `agent_ids` |
| `update_skill` | Existing `skill`, `body` and/or `description`, optionally both `expected_version` and `expected_body_sha256` | Existing update response |

For installation, supply a canonical `https://github.com/OWNER/REPO/tree/FULL_COMMIT` URL with a 40-character lowercase hex commit, an exact folder relative to the repository root (empty for the root), the expected native skill name, and one to eight unique active agent UUIDs. Use a stable key of one to 64 characters. The existing native reader downloads the pinned archive, selects one package, and applies native parsing, storage and source access limits. If any file would be ignored, installation fails. The importer stores accepted script files without executing them. An existing name, including a soft-deleted skill, prevents creation.

The server commits the skill, file references, selected assignments and grant-bound receipt together. After a lost response, retry the same payload and key with the same grant. An exact retry checks the current skill UUID, name, version, source URL, package digest and requested assignments. A changed payload, modified native skill or missing assignment yields a conflict. An error alone is insufficient evidence of an installation.

For assignment or conditional editing, read the current skill first. Use its immutable UUID, positive version, and the lowercase hexadecimal SHA-256 of the UTF-8 bytes of the native body. The server checks those values under a row lock. Assignment enables the requested existing agents and preserves their other skills. A conditional edit requires the UUID in `skill` and both preconditions. A conflict calls for fresh readback before another decision.
