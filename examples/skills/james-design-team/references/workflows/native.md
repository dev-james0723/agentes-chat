# Native UI and spatial interfaces

## Select the real platform

Determine the target OS, framework, device family and current app structure from the task and project. A brand name does not imply React, SwiftUI or another stack. Use the platform's existing implementation and available tools.

Reuse native navigation, focus, accessibility semantics, system controls and gesture conventions where suitable. Keep a deliberate custom interaction understandable and testable. Route React-only motion rules away from native implementations.

## Build and inspect

- Include the states that matter to this task: loading, empty, error, permission denial, interrupted work, long content and return navigation.
- Check safe areas, system bars, keyboard appearance, scrolling, dynamic type, text truncation and the current device's orientation requirements.
- Check meaningful labels, focus order, touch targets and reduced-motion alternatives using the actual platform tools.
- For spatial work, describe the intended input, depth, reach and comfort assumptions. Use device evidence when available; label an untested spatial behavior as unverified.
- Capture the implemented app on the relevant simulator or device. A web mockup does not establish native behavior.

Use screenshots for appearance and interaction evidence for behavior. Record the OS/device or simulator, app version, screen/state and reproduction steps. If a tool or device is unavailable, report the specific gap and complete the useful work that remains possible.

## Review and handoff

Give the independent reviewer the actual build or reproducible screen, source changes and captures. Follow [review](review.md) and [delivery](delivery.md); do not turn a web browser check into a native pass.

## Method sources

Original integration informed by pinned [Impeccable iOS guidance](https://github.com/pbakaus/impeccable/blob/b49177d32788f2dc585c42831d845dacf1ebed2c/.agents/skills/impeccable/reference/ios.md), [native audit](https://github.com/pbakaus/impeccable/blob/b49177d32788f2dc585c42831d845dacf1ebed2c/.agents/skills/impeccable/reference/audit.native.md) and [native adaptation](https://github.com/pbakaus/impeccable/blob/b49177d32788f2dc585c42831d845dacf1ebed2c/.agents/skills/impeccable/reference/adapt.native.md). See [provenance](../provenance.json).
