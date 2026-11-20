# Native Designer Team release verification

Date: 2026-11-20
Package: james-design-team 1.0.1
Native package revision: 2
Implementation commit: a00dfc9541485465c22c5a8bb09540fbc949ab08
Source review: https://github.com/dev-james0723/agentes-chat/pull/67
Resource digest: e313b8cc8fda7691cff34008792637e4ff74226fccfd942cf98cf662eeca2303

## Outcome

The native package is installed and enabled for the existing ten designers. Each has one role-specific managed instruction section. Eight legacy skills were corrected with their native identities retained. Readback verified preservation of models, access, unrelated settings and prior skill assignments.

The final repeat deployment was unchanged: zero instruction, assignment or legacy-body changes and no additional package import. This is the production activation; the running server image was not rebuilt.

Source is pushed to the feature branch and PR 67 is open. Hosted checks did not start because of an account-level execution restriction. They are not green and the source PR has not been merged. This does not reverse the verified native installation.

## Automated and independent code verification

| Check | Result |
| --- | --- |
| Core routing/context/evidence tests | 34 passed |
| Deployment/preservation/idempotency tests | 18 passed |
| Complete extension suite | 52 passed |
| Package self-check | verified, release 1.0.1 |
| Local references and provenance keys | all resolve; six pinned sources |
| JSON/Python syntax and git diff whitespace | passed |
| Changed-file repository boundary check | passed; no app/package module changes |
| Fresh independent code review | no remaining findings |

The host did not have a standalone Bun executable. The changed-file boundary scan used the repository's existing checker in the running Bun environment. Full application lint/typecheck/build/dependency-license suites were not claimed; no application modules, dependency manifests, schemas or environment variables changed.

Review found and closed two concrete defects: accepting audio-only MP4 containers as video, and non-object publication-key input escaping the JSON error contract. Real ffmpeg fixtures independently confirmed the correction for audio-only M4A, ordinary audio-only MP4 and real MP4 video. WebM remains explicitly unverified.

## Native production canary

An isolated private channel contained the three relevant existing designers. Actual native run records, file artifacts and immutable deployment snapshots are retained privately with the target runtime.

| Stage | Actual observation |
| --- | --- |
| Oliver routing | Completed native run; self-check and plan exited 0; real plan artifact uploaded. Social owner, independent reviewer, both languages and all requested formats retained. |
| Noah production | Completed native run; three editable HTML sources, two 1080x1350 carousel PNGs and one 1080x1920 Story PNG produced and uploaded with a source ZIP. |
| Lily independent review | Completed separate native run; exact eight input copies matched their original hashes; three PNGs and matching sources reviewed; review record PASS with no observed defects. |
| Final native validator | Executed release 1.0.1; exit 0, verified true, state rendered, errors empty, six artifact checks valid. |
| Final task state | No active runs remained in the canary channel. |

All artwork is synthetic, bilingual zh-HK/en and visibly marked INTERNAL TEST / NOT FOR PUBLICATION. No actual event claims or public posting were involved.

The final PNG hashes inspected by the reviewer and release operator are:

| File | SHA-256 |
| --- | --- |
| carousel-slide-1.png | ba160128b0961956c54244ed23a7f6556768f101cd41e78ec24258f0657427d7 |
| carousel-slide-2.png | ea23fed54247f68bd04061199d733975f8d07113ee0d6ffc4fefceec6e0eb786 |
| story.png | 7ddacdbbfbbbcd722e5675f7f0e36243a9b8e22ff0e2c7ab4830c92b190d6f35 |

## Rendering and visual-evidence details

The initial local Chrome identity check failed, and required PNGs correctly remained incomplete. Production continued with a separate system AppKit/WebKit renderer built using installed Xcode tools. Actual PNG dimensions, source assertions, reproduction results and upload receipts were recorded. No application signature or approval settings were changed.

The independent review records a native image-delivery compatibility problem and a local image-viewer fallback. The native engine trace confirms the three read_file calls; provider-local viewer calls are not represented in that trace. The release operator also independently opened and visually inspected the exact final PNG bytes through Kynlo. Visual acceptance therefore does not rely solely on a successful file-read status or a supplied review JSON.

## Verified scope and remaining limits

- The executable validator checks local file evidence and supplied review/publication records. It does not authenticate a reviewer, perform aesthetic judgment or enforce a system-wide app policy.
- The inspected canary covers static bilingual exports and their editable HTML sources. It does not establish responsive website behavior, native-device interaction, assistive technology, real-platform cropping/compression or full accessibility conformance.
- Real Figma authoring, social account connections, scheduling and public publication were not exercised.
- MP4 checks establish video-track metadata and media-data presence, not full codec decoding. WebM needs additional track/render evidence.
- Native update endpoints have no compare-and-swap primitive. Immediate fresh reads, narrow writes, readbacks and private snapshots reduce the remaining concurrency risk.
- Existing long-running conversations are not claimed to have discarded previously loaded instructions; the verified tasks were fresh native tasks.
