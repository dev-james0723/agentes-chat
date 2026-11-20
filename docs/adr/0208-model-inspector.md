# ADR 0208 — Model Inspector and task continuity

Date: 2026-11-20

Status: Accepted for the explicitly configured workspaces.

## Context

Several agents may spend the same subscription allowance. Looking at one agent's last failure misses idle agents,
scheduled work and active missions on that account. A provider name alone does not identify the allowance: the
computer's own sign-in, a named account, a model-specific window and an API budget are distinct sources.

The earlier quota handoff mechanism already has native account qualification, model admission, transcript
continuity and model settings. This change extends those paths instead of introducing a second task runner.

## Decision

### 1. A deterministic worker owns inspection

The server inspects each workspace in `MODEL_INSPECTOR_ORG_IDS` every 60 seconds. The list is empty by default
and accepts exact workspace UUIDs. Polling does not create a language-model run. JEV, through the existing judge,
is used when a real model selection requires task and role judgment.

The sweep inventories nonarchived agents, active runs and missions, and enabled scheduled or event routines.
Shared usage refreshes are deduplicated and each probe has an eight-second deadline. Model-change commits are
serialized per workspace, and configuration comparisons prevent overlapping replicas from applying a stale proposal.
Existing paused work, ownership and
permission checks remain authoritative.

The defaults are a 95% switch threshold, a five-minute maximum observation age, a fifteen-minute agent cooldown
and at most four idle-agent switches per sweep. The threshold means that little allowance remains; it does not
mean the provider has exhausted the account. It does not impose an 80% spending cutoff.

### 2. Evidence determines available routes

Read both the machine's own plan usage and named account usage. Keep the account identity, applicable model
window, observation time and reset time. Missing, stale, invalid or inapplicable telemetry is unknown, never
zero usage. A fresh model-specific refusal applies only to the model and account it actually identifies.

Claude Code, Codex and Grok use the existing native subscription adapters. Candidate selection checks the
connected machine, account ownership, sign-in state, model and required tools before comparing task suitability,
remaining allowance and the other agents assigned to the pool. JEV may choose only from these qualified
candidates. The installation's `QUOTA_HANDOFF_TARGETS` also limits these candidates. JEV's absence or an unusable
answer does not invent a provider, model, account or permission.

Grok may lack a reliable headless quota percentage. An active Grok sign-in is reported separately from known
remaining capacity. If selected as a qualified fallback with unknown allowance, that uncertainty stays in the
decision and report; ordinary provider-limit handling remains in force. No synthetic percentage is assigned.

API budgets remain separate from subscription allowance. This feature grants no extra usage, new paid fallback,
credit allocation, credential access or budget increase.

### 3. Preserve the work when switching

For an idle agent, the sweep changes the default through native model settings after rechecking its configuration,
authority and target under a row lock. The audit records the source, target and reason. A concurrent edit or new
run invalidates the stale proposal rather than being overwritten.

An executing run keeps its current action and transcript. The normal executor decides at an existing safe
boundary, using the current task and its required tools; the inspector does not kill a process or replay an
unknown tool effect. Active work is marked for boundary handling in the fleet report. Scheduled work uses its
agent's current default when dispatched and receives the same boundary checks while executing.

A detached mission child may change runner only while native state proves it has not started and the connected
runner advertises `executors.taskModels: true`. This capability means ordinary Claude and Codex tasks forward the
selected model to their CLI, including the shared Claude task bridge; older runners cannot claim that guarantee.
Started or resuming children retain their executor and completed effects; normal wait and recovery paths handle their quota limits.
Grok is not a detached-child target where that native runner capability is unavailable, even when it qualifies
for the agent's ordinary conversation work.

Cooldown and bounded changes limit repeated switches and spread large fleet changes across several sweeps.
If no suitable route qualifies, the reason is visible and existing wait/recovery behavior remains available.

### 4. Status reads never cause a switch

The visible `model-inspector` agent receives `get_model_inspector_status` only in a configured workspace and
only for a real caller who currently holds both `manage_agents` and `view_usage`. The checks run again when the
tool executes. Another agent, an unattended run or a revoked caller cannot borrow the inspector owner's access.

The authenticated endpoint is `GET /api/app/organizations/{orgId}/model-inspector`, with the same permissions.
Both surfaces read stored observations. They do not refresh providers, invoke JEV, start a sweep or change models.
Reports distinguish a completed `sweep` from a read-only `snapshot`, include `lastSweepAt` and `stale`, and preserve
each quota observation's age. Reading a snapshot is not evidence that a background sweep completed.

## Compatibility and operation

No database migration or new credential is required. The worker reuses existing account, run, routine and audit
records. Workspaces outside the configured list keep their existing model behavior. The application reload enables
configuration; it does not replace the host's native runner or other local services.

To stop future inspection, remove the workspace from `MODEL_INSPECTOR_ORG_IDS` and reload the application.
Existing default changes remain auditable; restoring one uses normal model settings and a fresh suitability check.
Do not roll an agent back blindly while it is executing a task.

## Verification

Focused tests cover scoped configuration, percentage and freshness handling, duplicate sweeps, idle and active
work, native settings preservation, task-aware route choice, unknown Grok usage, permission revocation, cross-workspace
isolation and read-only status behavior. Deployment acceptance separately verifies the running image, the enabled
workspace, a completed native sweep and actual account evidence. Test results do not establish live provider capacity.
