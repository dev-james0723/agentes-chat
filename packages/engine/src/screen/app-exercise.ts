import { sha256 } from "../crypto";
import type { PlanReport } from "./plan";

/** A checked functional UI action with a newly visible literal result on the same native target. */
export function screenExercise(machineId: string, surface: "browser" | "desktop", report: PlanReport) {
  const one = report.steps[0];
  if (
    !one ||
    report.steps.length !== 1 ||
    report.stopped ||
    one.status !== "done" ||
    one.ran !== true ||
    !["click", "press", "select", "double_click"].includes(one.step.do) ||
    !one.expected?.met ||
    !report.before?.url ||
    !report.after?.url
  )
    return {};
  const output = one.step.expect?.trim();
  if (!output || output.length < 8 || output.length > 180 || /[\r\n]/.test(output)) return {};
  function target(value: string) {
    if (!URL.canParse(value)) return null;
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (surface === "desktop" && url.protocol === "desktop:") return `desktop://${url.host}`;
    if (surface === "browser" && url.protocol === "https:") return url.origin;
    return null;
  }
  const afterTarget = target(report.after.url);
  if (
    !afterTarget ||
    target(report.before.url) !== afterTarget ||
    report.after.at < report.before.at ||
    report.after.at - report.before.at > 60_000 ||
    report.before.lines.some((line) => line.includes(output)) ||
    !report.after.lines.some((line) => line.includes(output))
  )
    return {};
  const snapshot = report.after.lines.join("\n");
  return {
    appExercise: {
      machineId,
      surface,
      target: afterTarget,
      operation: one.step.do,
      outputHash: sha256(output),
      snapshotHash: sha256(snapshot),
      size: Buffer.byteLength(snapshot),
    },
  };
}
