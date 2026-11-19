import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { FOUNDRY_DOCKER_SECCOMP, foundryDockerChildFilter } from "../src/foundry-docker-bootstrap";

for (const architecture of ["arm64", "x64"] as const) {
  test(`runtime image refuses missing, empty or changed ${architecture} filter bytes during its build`, () => {
    const generated = foundryDockerChildFilter(architecture);
    const committed = readFileSync(new URL(`../docker/foundry/child-${architecture}.bpf`, import.meta.url));
    expect(Buffer.from(generated)).toEqual(committed);
    const hash = createHash("sha256").update(generated).digest("hex");
    const dockerfile = readFileSync(new URL("../docker/foundry/Dockerfile", import.meta.url), "utf8");
    expect(dockerfile).toContain(`${architecture}) expected=${hash}`);
    expect(dockerfile).toContain("sha256sum -c -");
  });
}
test("outer runtime policy asset matches the reviewed default-deny policy exactly", () => {
  const file = readFileSync(new URL("../docker/foundry/outer-seccomp.json", import.meta.url), "utf8");
  expect(file).toBe(JSON.stringify(FOUNDRY_DOCKER_SECCOMP));
});
