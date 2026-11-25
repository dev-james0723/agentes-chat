# Independent review

## Establish the review scope

Use the reviewer returned by the plan; the execution owner cannot approve their own output as an independent review. Lily is the default reviewer and the catalog names the fallback. Resolve the actual native agent by its current handle rather than copying deployment-specific IDs into files.

Inspect the exact content version, target platform and required artifacts. Record the viewport/device/export size, relevant states and reproduction steps. Use a source commit when available; a content version is still required when the task is not a code change.

## Inspect and report

- Check task fit, hierarchy, composition, typography, brand voice, factual copy, responsive or platform behavior, accessibility and relevant motion.
- Review real rendered artifacts. A screenshot supports visible appearance; behavior, semantics, keyboard access and audio need suitable direct evidence.
- Separate observed defects, incomplete coverage and optional preferences. Give severity, location, effect and a concrete correction.
- Do not invent issues to reach a quota. A clean review is valid when the tested scope supports it.
- If the task already authorizes fixes, resolve the relevant issues and review the changed version again.
- If the output or required device cannot be inspected, report NOT_VERIFIED and the precise missing evidence.

Use PASS only for the inspected version and scope; otherwise use CHANGES_REQUIRED or NOT_VERIFIED. Do not silently transmit artifacts, identifiers or telemetry to an external review service.

## Manifest handoff

A passing machine-readable review uses `reviewerId` from the plan, `result:"pass"`, `platform` equal to the plan's surface, the matching `contentVersion`, and `evidence` paths covering every required artifact actually inspected, including editable source. Include detailed findings in the task's review record.

Run the delivery validator after recording genuine review evidence. It can check identities, versions and files; it cannot perform the visual inspection or prove that a reviewer actually looked at the work.

## Method sources

Original integration informed by pinned [Impeccable critique rubric](https://github.com/pbakaus/impeccable/blob/b49177d32788f2dc585c42831d845dacf1ebed2c/.agents/skills/impeccable/reference/critique-rubric.md), [Agency evidence collection](https://github.com/msitarzewski/agency-agents/blob/8ae6164602c95ca78828b148b9052460ee426885/testing/testing-evidence-collector.md) and [Design Jarvis accessibility review](https://github.com/renfei-design/Design-Jarvis/blob/05fe0be9e2b74fcc465055b9545a4b3441e9822f/.github/skills/a11y-review/SKILL.md). See [provenance](../provenance.json).
