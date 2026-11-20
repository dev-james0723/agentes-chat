# Delivery and publication evidence

## Version the actual work

Keep one task workspace containing the editable source, requested exports and review record. Name the required deliverables consistently between the plan and manifest. Record each artifact's relative path and the same content version used by the review.

Use precise states: draft, rendered, scheduled, published, failed or unverified. A concept is draft. A real exported artifact can be rendered after the required checks. A platform's accepted schedule is scheduled; it is not yet published.

## Validate local delivery

The validation input is an object with `plan` and `manifest`. The manifest contains `status`, `contentVersion`, `artifacts` and `review`. Each artifact contains `deliverable`, `path` and `contentVersion`. Review fields include `reviewerId`, `result`, `platform`, `contentVersion` and `evidence`.

For example, a reviewed social package can use deliverables `carousel`, `story` and `editable-source`, with real PNG exports and a source file. The review's evidence paths must cover every required artifact, including editable source; a paragraph claiming the visuals exist is not file evidence.

Run `validate --input design/delivery.json --workspace .` from the task workspace. Read `verified`, `state`, `errors`, `warnings`, `nextAction` and `artifactChecks`. Resolve the specific gaps; do not relabel an incomplete artifact to evade a check.

The validator checks local file evidence and recorded metadata. File signatures are not a full media decode. A passing result does not certify design quality, remote publication truth or app-wide enforcement.

## Authorized publication

Honor the task's current publication authorization and existing platform access. Before calling a publishing tool, record the intended account, channel, task, content version and variant so the operation can be identified later.

Use `publication-key --input design/publication-intent.json` with `accountId`, `channel`, `taskId` and `contentVersion`, plus any `brand`, `locale`, `format` or `destination`. The stable key helps correlate the intent; it does not provide server-side idempotency.

A `publication` receipt records `accountId`, `channel` and `contentVersion`; published requires `postId` and `permalink`, while scheduled requires `jobId` and `scheduledAt`. Its `readback` repeats the matching fields and records `confirmed:true` only after an actual platform read. Read the resulting platform state back before reporting published. On timeout or an ambiguous result, mark unverified and inspect the platform before retrying; do not create a duplicate merely because the first response was missing.

No script in this package publishes externally. State the completed outputs, actual review scope and any remaining platform or artifact gap in the final handoff.

## Method sources

Original integration informed by pinned [Design Jarvis handoff](https://github.com/renfei-design/Design-Jarvis/blob/05fe0be9e2b74fcc465055b9545a4b3441e9822f/.github/skills/generate-ux-handoffspec/SKILL.md), [Agency finish review](https://github.com/msitarzewski/agency-agents/blob/8ae6164602c95ca78828b148b9052460ee426885/design/design-ui-finish-gate-reviewer.md) and [LangChain generation graph](https://github.com/langchain-ai/social-media-agent/blob/bc27973c9c11f5c4929d78f26cb9ed200ab017f2/src/agents/generate-post/generate-post-graph.ts). Local receipt and validation conventions are this integration's own implementation.
