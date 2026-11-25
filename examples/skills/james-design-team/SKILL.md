---
name: james-design-team
description: Coordinate James's existing Designer Team for frontend, native UI, brand, social content, typography, motion and delivery reviews. Use when a design task needs a scoped brief, the right craft skills, real artifacts or independent visual evidence.
---

# James Design Team

Use the existing team and the current task's authorization. This package routes work and checks supplied evidence; it does not grant connectors, enforce policy across the app or substitute for visual inspection.

## Start with the task

1. Recover the brief from the current request and project: brand, audience, user job, surface, actual stack, languages, required outputs and constraints. Ask only for missing information that materially changes the result.
2. Run `plan` with that brief. Use one accountable execution owner, relevant collaborators and a different reviewer. Oliver coordinates; he does not replace every craft owner.
3. Read only the returned workflow references and load the selected skills that are actually available in the native session. Keep explicitly requested skills discoverable; a catalog entry does not prove a tool is connected.
4. Produce the requested editable implementation and real exports. A prompt, storyboard or screenshot of a text plan is not the requested image, interface or video.
5. Have the assigned independent reviewer inspect the exact rendered version on its target surface. Correct observed issues and recheck the affected output.
6. Run `validate` with the plan, artifact manifest and task workspace. Report its errors and remaining observation gaps accurately.
7. Deliver useful artifacts and the tested scope. Save accepted brand decisions with their source and project identity.

## Native execution

Use the native `run_skill_script` tool with this payload; paths in the input file refer to the current task workspace.

```json
{"skill":"james-design-team","path":"scripts/design_team.py","args":["plan","--input","design/brief.json"],"timeout_seconds":30}
```

Use `args:["catalog"]` to inspect routing methods, and `args:["self-check"]` to check installed package files. Use `publication-key` with a JSON input file to record a stable publishing intent; it makes no network call. For delivery use `args:["validate","--input","design/delivery.json","--workspace","."]`. The delivery file contains `{"plan":{...},"manifest":{...}}`.

For a short local example:
```sh
python3 scripts/design_team.py plan --request-json '{"taskId":"test-social","brand":"james","surface":"social","brief":"Bilingual TEST announcement","languages":["zh-Hant-HK","en"],"deliverables":["carousel","story","editable-source"]}'
```

Native script arguments are limited to 500 characters each; use `--input` for a full brief or delivery manifest. `self-check` confirms package integrity. `validate` checks local files and recorded evidence; neither command makes an aesthetic judgment, authenticates a remote post or performs publication.

## Read when relevant

- [Product and frontend](references/workflows/product.md): flows, components, research and implementation.
- [Social production](references/workflows/social.md): source claims, channel copy and visual packages.
- [Native UI](references/workflows/native.md): platform behavior, simulator/device evidence and spatial interfaces.
- [Brand and imagery](references/workflows/brand.md): project identity, voice and art direction.
- [Typography and HK bilingual composition](references/workflows/typography.md): legibility, localization and export constraints.
- [Motion](references/workflows/motion.md): stack selection, storyboards and rendered video.
- [Independent review](references/workflows/review.md): observable findings and evidence.
- [Delivery](references/workflows/delivery.md): versioned artifacts, receipts and publication state.
- [Design memory](references/workflows/memory.md): scoped, sourced decisions.

Routing data lives in [capabilities](references/capabilities.json) and [roles](references/roles.json). [Provenance](references/provenance.json) records pinned research sources. The bundled workflows are original integrations; upstream repositories and their execution environments are not installed by this package.
