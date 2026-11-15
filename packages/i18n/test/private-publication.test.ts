import { expect, test } from "bun:test";
import { en, STRINGS } from "../src";
import { LOCALES } from "../src/locale";
import { checkLocale } from "./check-locale";

for (const { code, ready } of LOCALES)
  test(`private publication consent is complete in ${code}`, () => {
    const target = (STRINGS[code] as typeof en).privatePublication;
    expect(Object.keys(target)).toHaveLength(10);
    expect(
      checkLocale({
        source: { privatePublication: en.privatePublication },
        target: { privatePublication: target },
        code,
        ready,
      }),
    ).toEqual([]);
  });
