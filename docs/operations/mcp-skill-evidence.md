# Verifying a skill through an AI-app connection

The official MCP tool `read_skill_evidence` requires the connection's `manage` scope. It is read-only. The grant owner, workspace and channel visibility come from native authorization. An existing read or write grant continues to expose its original tools.

The request takes a `skill_id`, one to eight distinct `agent_ids`, and exactly one of `task_ids` or `run_ids` (one to eight distinct UUIDs). Prefer the `task_id` persisted from the caller's own `send_to_agent` receipt. It is the trigger message UUID. A task with multiple directly triggered runs is ambiguous. In that case provide known run IDs and compare each returned trigger ID with the stored receipt. Runs from another grant, another person or another workspace, unreadable conversations and runs of agents outside the requested set are refused. Each request reads one database snapshot.

The structured response includes the following fields.

| Field | Meaning |
| --- | --- |
| `skill` | ID, name, version, exact Markdown body without frontmatter in `body.untrusted_text`, and version-scoped file metadata in `files[]`: `path.untrusted_text`, byte size, MIME and storage status (stored, script or ignored). File bytes and file content hashes are not returned. |
| `assignments[agentId].skills` | Native ID, version and enabled flag for the requested skill. |
| `runs[runId].run` | Native run ID, agent ID, status and original trigger message ID. |
| `runs[runId].steps` | Successful native `load_skill` result records for this skill only. Inspect `data.data.skill.version` for the version actually loaded. |
| `runs[runId].trigger` and `.reply` | IDs, native conversation links and exact original text in `untrusted_text`. The reply can be null. Edited or deleted messages cannot support a positive result. |

Compare the native trigger ID with the dispatch receipt. Check the trusted target agent, current assignment, and exact version in the load result. Evaluate the actual reply with an action-specific fixture and expected result chosen before the run. A task completing, a successful load, or the agent reporting success alone is insufficient. Apps can hash the exact UTF-8 body and compare it with a trusted artifact baseline. Packages with additional files need independent file verification.

Oversized or unsupported evidence fails explicitly. The tool caps skill bodies at 32,768 characters, messages at 8,192, file paths at 128 per skill and successful loads at 32 per run. Text with hidden control characters is rejected to preserve both byte fidelity and MCP text handling. Raw model transcripts, unrelated tool inputs, results and message metadata are excluded.

Local integration checks use `bun test apps/server/test/mcp-skill-evidence.test.ts apps/server/test/mcp-manage.test.ts`. There are no schema migrations.
