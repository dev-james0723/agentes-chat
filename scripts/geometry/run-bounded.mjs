import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check.ts", import.meta.url));
const grace = 5_000;

export function stageLimit(raw = process.env.GEOMETRY_STAGE_MS) {
  const limit = raw === undefined ? 540_000 : Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1_000 || limit > 540_000) {
    throw new Error("GEOMETRY_STAGE_MS must be between 1000 and 540000ms");
  }
  return limit;
}

/**
 * Independent of Bun/Chrome's event loop. Own a new process group, never the user's shell or another CI.
 * On expiry or interruption report failure, ask the entire owned group to stop, then escalate within the grace.
 */
export function runBounded(command, args, { ms, graceMs = grace, env = process.env } = {}) {
  const grouped = process.platform !== "win32";
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { detached: grouped, stdio: "inherit", env });
    let stopping = false;
    let exited = false;
    let finished = false;
    let timer;
    let escalation;
    let result = 1;

    const signal = (name) => {
      try {
        if (!child.pid) return;
        if (grouped) process.kill(-child.pid, name);
        else if (!exited) child.kill(name);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    const exists = () => {
      if (!child.pid) return false;
      if (!grouped) return !exited;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") return false;
        return true;
      }
    };
    const finish = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      resolveRun(code);
    };
    const terminate = (code, reason) => {
      if (stopping || finished) return;
      stopping = true;
      result = code;
      clearTimeout(timer);
      console.error(`[geometry watchdog] ${reason}; stopping owned browser/test process group`);
      try {
        signal("SIGTERM");
      } catch (error) {
        console.error("[geometry watchdog] TERM failed:", error);
      }
      escalation = setTimeout(() => {
        try {
          if (exists()) signal("SIGKILL");
        } catch (error) {
          console.error("[geometry watchdog] KILL failed:", error);
        }
        // Never wait indefinitely for a stuck child or its inherited pipes.
        child.unref();
        finish(result);
      }, graceMs);
      if (exited && !exists()) finish(result);
    };
    const interrupt = () => terminate(130, "interrupted");
    process.once("SIGTERM", interrupt);
    process.once("SIGINT", interrupt);
    child.once("error", (error) => {
      if (!child.pid) {
        clearTimeout(timer);
        clearTimeout(escalation);
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", interrupt);
        reject(error);
      } else terminate(1, `child error: ${error.message}`);
    });
    child.once("exit", (code, exitSignal) => {
      exited = true;
      if (stopping) {
        if (!exists()) finish(result);
        return;
      }
      if (exists()) terminate(code && code > 0 ? code : 1, "runner exited with surviving owned child processes");
      else finish(code ?? (exitSignal ? 1 : 0));
    });
    timer = setTimeout(() => terminate(124, `stage exceeded ${ms}ms`), ms);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const ms = stageLimit();
    console.log(`[geometry watchdog] hard stage deadline: ${ms}ms`);
    process.exitCode = await runBounded("bun", [script, ...process.argv.slice(2)], { ms });
  } catch (error) {
    console.error("[geometry watchdog] FAILED:", error);
    process.exitCode = 1;
  }
}
