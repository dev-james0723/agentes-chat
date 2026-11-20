# Product and frontend

## Brief and evidence

Recover the audience, user job, desired action, constraints and existing product states before proposing a direction. Distinguish observed user evidence, stakeholder intent and hypotheses. Synthetic personas and generated interviews are design aids; never report them as real participant research.

Inspect the actual repository, routes, assets, tokens and relevant product decisions. Respect the current request when it intentionally changes a previous direction. For a narrow fix, keep the scope narrow. For a new direction, explain the visual thesis and how it supports the task.

## Production

- Map the main flow and relevant loading, empty, error, success, disabled and long-content states.
- Choose one primary craft method per stage. Use existing components where suitable; record a deliberate divergence when the brief needs it.
- Apply `frontend-design`, `better-layout` and `better-typography` when available and relevant. React motion guidance applies only to that implementation stack.
- Define hierarchy, spacing, type, contrast and responsive behavior using real content. Keep the established architecture unless changing it serves the requested result.
- For Figma work, verify the actual tool and document first. Record real frame/component identifiers and handoff links; do not invent a connected Figma session or node.
- For data views, preserve units, definitions and uncertainty; check the source values. For email, conversation and spatial flows, use their actual client or platform constraints rather than importing a web layout unchanged.

Produce editable code/design source and required rendered views. Exercise the main interaction and affected states. A screenshot can support an appearance claim; it cannot prove keyboard behavior, navigation or data correctness.

## Handoff

Give the reviewer the target surface, content version, observed routes/states, reproduction steps and artifact paths. Include implementation decisions that affect future work, then follow [review](review.md) and [delivery](delivery.md).

## Method sources

Original integration informed by pinned [Design Jarvis UX brief](https://github.com/renfei-design/Design-Jarvis/blob/05fe0be9e2b74fcc465055b9545a4b3441e9822f/.github/skills/ux-brief/SKILL.md), [implementation handoff](https://github.com/renfei-design/Design-Jarvis/blob/05fe0be9e2b74fcc465055b9545a4b3441e9822f/.github/skills/generate-ux-handoffspec/SKILL.md), [Anthropic frontend design](https://github.com/anthropics/skills/blob/e4bb5d960d87126ff3b3a8af1a104b7db67560ba/skills/frontend-design/SKILL.md) and [Impeccable layout](https://github.com/pbakaus/impeccable/blob/b49177d32788f2dc585c42831d845dacf1ebed2c/.agents/skills/impeccable/reference/layout.md). See [provenance](../provenance.json).
