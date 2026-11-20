import { expect, test } from "bun:test";
import { loadConfig } from "./index";

const required = { DATABASE_URL: "postgres://u:p@localhost:5432/test", AGENTES_SECRET: "x".repeat(48) };
const first = "b221b439-4343-459b-bd26-f2abd0dfe764";
const second = "0193eeee-0000-4000-8000-0000000000a1";

test("inspection is opt-in and its defaults keep fresh observations and a switch cooldown", () => {
  const config = loadConfig(required);
  expect(config.MODEL_INSPECTOR_ORG_IDS).toEqual([]);
  expect(config.MODEL_INSPECTOR_THRESHOLD_PERCENT).toBe(95);
  expect(config.MODEL_INSPECTOR_MAX_AGE_MS).toBe(300_000);
  expect(config.MODEL_INSPECTOR_COOLDOWN_MS).toBe(900_000);
  expect(config.MODEL_INSPECTOR_MAX_SWITCHES).toBe(4);
});

test("workspace parsing trims and deduplicates exact IDs; it never admits a wildcard", () => {
  expect(
    loadConfig({ ...required, MODEL_INSPECTOR_ORG_IDS: ` ${first}, ${second},${first}, ` }).MODEL_INSPECTOR_ORG_IDS,
  ).toEqual([first, second]);
  for (const value of ["*", "all", `${first},not-a-workspace`, `${first} ${second}`]) {
    expect(() => loadConfig({ ...required, MODEL_INSPECTOR_ORG_IDS: value })).toThrow(/MODEL_INSPECTOR_ORG_IDS/);
  }
});

test("invalid polling policy fails configuration instead of silently routing on it", () => {
  for (const [key, value] of [
    ["MODEL_INSPECTOR_THRESHOLD_PERCENT", "101"],
    ["MODEL_INSPECTOR_THRESHOLD_PERCENT", "0"],
    ["MODEL_INSPECTOR_MAX_AGE_MS", "0"],
    ["MODEL_INSPECTOR_COOLDOWN_MS", "-1"],
    ["MODEL_INSPECTOR_MAX_SWITCHES", "0"],
    ["MODEL_INSPECTOR_MAX_SWITCHES", "1.5"],
  ] as const) {
    expect(() => loadConfig({ ...required, [key]: value })).toThrow(key);
  }
});
