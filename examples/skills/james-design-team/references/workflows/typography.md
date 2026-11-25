# Typography and Hong Kong bilingual composition

## Language and voice

Use the requested register: Hong Kong written Traditional Chinese, Cantonese, English or a deliberate bilingual combination. Preserve the brand's approved names, terminology and factual meaning. Do not convert formal written Chinese to casual Cantonese solely because the audience is in Hong Kong.

Draft each language naturally rather than copying the other language's word order. Keep dates, prices, calls to action and qualifications consistent. Ask about an unresolved name or term only when choosing incorrectly would materially change the output.

## Composition checks

- Use the project's existing type system where suitable. Check actual CJK glyph coverage, fallback behavior and font availability; a declared font name is not evidence that the rendered font loaded.
- Establish a clear relationship between Chinese and Latin text through hierarchy, optical size, weight, spacing and line height.
- Inspect real line breaks, punctuation, names, numbers and URLs. Do not apply a Latin character-count measure as a universal Chinese line-length rule.
- Prevent clipped glyphs, overlapping baselines, hidden copy and awkward breaks at the intended output size. Compare language variants using their real content.
- Test long content and text scaling where the surface supports them. Use `better-typography` and `better-layout` as relevant craft helpers.
- For slides and social visuals, inspect exports at plausible viewing size. For print, check the requested dimensions, bleed, color/export requirements and embedded fonts with the actual production workflow.

## Evidence

Give the reviewer the actual bilingual exports and editable source. Record the tested dimensions, language variants and any fallback font observed. Correct the layout after copy changes; an older render cannot prove the revised text fits.

Follow [review](review.md) and [delivery](delivery.md). These HK composition checks are local integration guidance, not a claim that every upstream repository provides Hong Kong localization.

## Method sources

Original integration informed by pinned [Impeccable typesetting](https://github.com/pbakaus/impeccable/blob/b49177d32788f2dc585c42831d845dacf1ebed2c/.agents/skills/impeccable/reference/typeset.md), [Design Jarvis Stringweaver](https://github.com/renfei-design/Design-Jarvis/blob/05fe0be9e2b74fcc465055b9545a4b3441e9822f/.github/skills/stringweaver/SKILL.md) and [Agency internationalization](https://github.com/msitarzewski/agency-agents/blob/8ae6164602c95ca78828b148b9052460ee426885/engineering/engineering-i18n-engineer.md). See [provenance](../provenance.json).
