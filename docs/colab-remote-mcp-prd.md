# Google Colab remote compute — product requirements

Date: 2026-11-20
Status: implementation candidate; authenticated rollout pending
Related: [engineering specification](colab-remote-mcp-spec.md), [setup guide](colab-remote-mcp.md), [ADR 0200](adr/0200-colab-remote-mcp.md), [implementation plan](superpowers/plans/2026-11-20-colab-remote-mcp.md)

## Outcome

Existing agents can send bounded Python and GPU work to the Google account's Colab runtimes, retrieve durable results, and continue their existing workflow. The local computer continues to coordinate agents and operate local applications. Adding Colab does not move the coordinator into the cloud.

The first useful workloads are batches of audio transcription, document extraction and embeddings, and image or asset processing. Existing connected transcription, document, or media services remain valid choices when they already deliver the required output with less setup.

## Responsibilities

| Role | Responsibility |
| --- | --- |
| Workspace owner | Signs in with the intended Google account and maintains its Colab subscription |
| Platform engineer | Maintains OAuth configuration, deployment, account health and the playbook |
| Coordinator | Chooses a worker and defines inputs, outputs, time limit and acceptance check |
| Worker | Records runtime/session/execution IDs, runs a bounded task, saves outputs and closes its session |
| Reviewer | Checks output quality and verifies durable delivery |

Existing global All tools grants remain effective. A workspace using narrower access can grant Colab read and run scopes without changing other services. Runtime deletion follows the existing sensitive-action and approval policy.

## Requirements

| ID | Requirement | Acceptance evidence |
| --- | --- | --- |
| R1 | Offer Colab in the existing catalog using its official remote MCP endpoint | Available only when both OAuth client values are configured; OAuth-only UI labels are accurate |
| R2 | Use a Google Web OAuth client, Colab scope, PKCE, consent and offline access | Real consent completes; an authenticated call succeeds after refresh |
| R3 | Preserve current models, instructions, permissions, approvals and other connectors | Before/after settings differ only by intended Colab and playbook setup |
| R4 | Public initialization or discovery must not create a purported signed-in connection | Pasting the official URL starts fixed OAuth; pasted bearer credentials are refused |
| R5 | Long calls must not hit the SDK's early cancellation | Only official create_runtime and execute_code use 660000 ms; a live call beyond 60 seconds succeeds |
| R6 | Do not automatically duplicate uncertain work | Adapter dispatches once; recovery retains request/session/execution identifiers |
| R7 | Provide reusable guidance for transcription, OCR/embeddings and asset batches | Playbook is enabled for intended current agents without disabling other skills |
| R8 | Save outside temporary runtimes and clean up only task-owned sessions | Retrieve and verify a smoke-test artifact; close only the owned session |
| R9 | Preserve the live installation and retain rollback | Derive from immutable current image, reconcile overlays, validate in isolation, retain old image/config |
| R10 | Separate source, authentication and workload evidence | Completion record states checks actually run and remaining limits |

## Initial workload contracts

### Audio transcription

Input: authorized audio/video, requested language, timestamp and speaker requirements.
Output: transcript, optional subtitles, structured segments and a quality report.
Acceptance: check beginning/middle/end samples, language, omissions, timing and names. Mark uncertain speech. Do not infer speaker identity from text alone.

Use an existing transcription connector when it meets the task. Colab is useful when batch size, model control, preprocessing or an accelerator justifies transfer and setup time.

### OCR and embeddings

Input: authorized documents, source identifiers and an explicit destination.
Output: text with page/source references, quality report, optional chunks and embedding files.
Acceptance: compare selected pages with originals and check page order/counts. Record embedding model/version, vector dimension, normalization and chunk policy; verify row counts and a retrieval sample.

Embedding generation does not itself create a searchable knowledge base. Import into a durable index only when that destination and import are part of the task.

### Asset batches

Input: source assets, transformation specification and output requirements.
Output: separate processed files and an input/output manifest.
Acceptance: verify dimensions, format/duration when relevant, sample previews and failed-item reporting. Preserve originals.

CPU conversion, resizing or compression may be better locally. Request a GPU for a measured or clear accelerator-dependent operation.

## Boundaries

This release adds a connector and reusable guidance. It adds no permanent GPU server, scheduler, CU balance meter, purchase automation, training platform, recurring job or automatic publishing pipeline.

Eligibility, capacity, idle and lifetime limits still apply. get_subscription reports a tier, not remaining compute units. Sessions on one runtime share its hardware.

If the local server sleeps, new orchestration stops even when submitted cloud code can continue. A continuously available coordinator is a separate deployment decision.

## Rollout success

Operational means the real Google account can read its subscription/specifications, run Python, complete a call beyond 60 seconds, retrieve a result file, and call an authenticated tool after refresh. Intended agents must have effective connector access and the playbook enabled.

Recipes can be installed without processing actual user audio, documents or assets. Report that distinction and do not claim an actual GPU workload ran unless it did.

## Sources

- [Colab tools, file transfer and execution semantics](https://developers.google.com/colab/api/reference/mcp)
- [Google remote MCP authentication](https://docs.cloud.google.com/mcp/set-up-authentication-mcp-servers)
- [Google OAuth web applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Colab runtime limits](https://research.google.com/colaboratory/faq.html)
