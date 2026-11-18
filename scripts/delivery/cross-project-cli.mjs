// Additional bounded observers for the existing Guardian entry point.
// Input selects approved roots/targets; it cannot supply executable adapters.

import { collectAgentChats } from "./adapters/agent-chats.mjs";
import { collectMacOSApp } from "./adapters/macos-app.mjs";
import { collectRepositoryInventory } from "./identity.mjs";

export async function runCrossProject(command, input) {
  if (!["identity", "inspect-macos", "inspect-agent-chats"].includes(command))
    throw new Error("Unknown read-only Guardian command");
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("JSON object required");
  if (["run", "platform", "providerLookup", "readRecord", "env", "command"].some((key) => key in input))
    throw new Error("Executable and platform adapters are host-only");
  if (command === "identity") {
    if (
      !Array.isArray(input.approvedRoots) ||
      input.approvedRoots.length < 1 ||
      input.approvedRoots.length > 64 ||
      input.approvedRoots.some((root) => typeof root !== "string" || !root.startsWith("/"))
    )
      throw new Error("Explicit approvedRoots required");
    const roots = input.roots ?? (input.root ? [input.root] : []);
    if (!Array.isArray(roots) || roots.length < 1 || roots.length > 32)
      throw new Error("Select one to thirty-two roots");
    return collectRepositoryInventory({ roots, approvedRoots: input.approvedRoots, remote: input.remote ?? "origin" });
  }
  if (command === "inspect-macos")
    return collectMacOSApp({ bundlePath: input.bundlePath, expectedBundleId: input.expectedBundleId, pid: input.pid });
  return collectAgentChats({
    dockerContext: input.dockerContext,
    containerName: input.containerName,
    runnerPath: input.runnerPath,
    runnerPids: input.runnerPids,
  });
}
