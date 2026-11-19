import { envVars } from "../../config/src/schema";
import { getSharedMemoryMem0Readiness, runMem0SyntheticEvaluation } from "../src/context/shared-memory-mem0";
import { MEM0_SYNTHETIC_CASES } from "../src/context/shared-memory-mem0-cases";

// Only the three declared Mem0 settings are read. No database, source archive, or personal memory is loaded.
const config = {
  MEM0_ENABLED: envVars.MEM0_ENABLED.schema.parse(process.env.MEM0_ENABLED || undefined),
  MEM0_API_KEY: envVars.MEM0_API_KEY.schema.parse(process.env.MEM0_API_KEY || undefined),
  MEM0_REQUEST_TIMEOUT_MS: envVars.MEM0_REQUEST_TIMEOUT_MS.schema.parse(
    process.env.MEM0_REQUEST_TIMEOUT_MS || undefined,
  ),
};

if (!process.argv.includes("--live")) {
  console.log(
    JSON.stringify(
      { ...getSharedMemoryMem0Readiness(config), evaluation: "not_run", syntheticCases: MEM0_SYNTHETIC_CASES.length },
      null,
      2,
    ),
  );
} else {
  const report = await runMem0SyntheticEvaluation({ config });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === "passed" ? 0 : report.status === "unavailable" ? 2 : 1;
}
