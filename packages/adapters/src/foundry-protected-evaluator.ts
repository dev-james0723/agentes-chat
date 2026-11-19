import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, lstatSync, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import {
  FOUNDRY_DOCKER_CONTROL_TIMEOUT_MS,
  type FoundryDockerControl,
  foundryDockerCreateArgs,
  removeFoundryContainerByName,
} from "./foundry-docker-runner";
import {
  type FoundryAdmission,
  type FoundryEvaluationCancellationResult,
  type FoundryEvaluationReceipt,
  type FoundryEvaluationResult,
  type FoundryExecutionResult,
  type FoundryFrozenVersion,
  type FoundryLimits,
  type FoundryRunnerExecutionRequest,
  hashFoundryInput,
} from "./foundry-executor";
import { type ReceiptOraclePlan, type ReceiptOracleVerdict, receiptOracleProgram } from "./foundry-receipt-oracle";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
interface Row {
  jobRef: string;
  identity: string | null;
  phase: string;
  context: string | null;
  seed: string | null;
  deadline: number;
  oracleContainer: string | null;
  result: string | null;
  evidence: string | null;
}
interface Step {
  invocationId: string;
  jobRef: string;
  inputDigest: string;
  phase: string;
}

/** Private evaluator/control journal only. Native outbox owns job scheduling.
 * A RESERVED or RUNNING record is never reclaimed after restart. */
export class ProtectedFoundryEvaluationLedger {
  readonly db: Database;
  constructor(filename: string) {
    if (!isAbsolute(filename) || (lstatSync(dirname(filename)).mode & 0o077) !== 0)
      throw new Error("Evaluator storage must be in an operator-private directory");
    try {
      const fd = openSync(filename, "wx", 0o600);
      closeSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink())
        throw new Error("Unsafe evaluator storage");
    }
    chmodSync(filename, 0o600);
    this.db = new Database(filename, { strict: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA busy_timeout=1000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS protected_evaluations (
      jobRef TEXT PRIMARY KEY, identity TEXT, phase TEXT NOT NULL, context TEXT, seed TEXT,
      deadline INTEGER NOT NULL, oracleContainer TEXT, result TEXT, evidence TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS protected_evaluation_steps (
      invocationId TEXT PRIMARY KEY, jobRef TEXT NOT NULL, inputDigest TEXT NOT NULL, phase TEXT NOT NULL
    ) STRICT;`);
  }
  read(job: string): Row | null {
    return this.db.query<Row, [string]>("SELECT * FROM protected_evaluations WHERE jobRef=?").get(job);
  }
  reserve(job: string, identity: string, context: string, deadline: number): boolean {
    return (
      this.db
        .query(
          "INSERT INTO protected_evaluations(jobRef,identity,phase,context,seed,deadline) VALUES(?,?,'RESERVED',?,?,?) ON CONFLICT DO NOTHING",
        )
        .run(job, identity, context, randomBytes(32).toString("hex"), deadline).changes === 1
    );
  }
  start(job: string, identity: string): boolean {
    return (
      this.db
        .query("UPDATE protected_evaluations SET phase='RUNNING' WHERE jobRef=? AND identity=? AND phase='RESERVED'")
        .run(job, identity).changes === 1
    );
  }
  oracle(job: string, id: string | null): boolean {
    return (
      this.db
        .query("UPDATE protected_evaluations SET oracleContainer=? WHERE jobRef=? AND phase='RUNNING'")
        .run(id, job).changes === 1
    );
  }
  step(job: string, id: string, inputDigest: string): boolean {
    return (
      this.db
        .query(`INSERT INTO protected_evaluation_steps(invocationId,jobRef,inputDigest,phase)
      SELECT ?,?,?,'RESERVED' WHERE EXISTS(SELECT 1 FROM protected_evaluations WHERE jobRef=? AND phase='RUNNING') ON CONFLICT DO NOTHING`)
        .run(id, job, inputDigest, job).changes === 1
    );
  }
  steps(job: string): Step[] {
    return this.db.query<Step, [string]>("SELECT * FROM protected_evaluation_steps WHERE jobRef=?").all(job);
  }
  completeStep(id: string): void {
    this.db.query("UPDATE protected_evaluation_steps SET phase='TERMINATED' WHERE invocationId=?").run(id);
  }
  requestCancel(job: string): void {
    this.db
      .transaction(() => {
        this.db
          .query(
            "INSERT INTO protected_evaluations(jobRef,phase,deadline) VALUES(?,'CANCELLED',0) ON CONFLICT DO NOTHING",
          )
          .run(job);
        this.db
          .query(
            "UPDATE protected_evaluations SET phase=CASE WHEN phase='RESERVED' THEN 'CANCELLED' ELSE 'CANCEL_REQUESTED' END WHERE jobRef=? AND phase IN ('RESERVED','RUNNING')",
          )
          .run(job);
      })
      .immediate();
  }
  cancelled(job: string): void {
    this.db
      .query(
        "UPDATE protected_evaluations SET phase='CANCELLED',oracleContainer=NULL WHERE jobRef=? AND phase='CANCEL_REQUESTED'",
      )
      .run(job);
  }
  finish(job: string, identity: string, result: string, evidence: string): boolean {
    return (
      this.db
        .query(
          "UPDATE protected_evaluations SET phase='TERMINAL',result=?,evidence=? WHERE jobRef=? AND identity=? AND phase='RUNNING' AND oracleContainer IS NULL",
        )
        .run(result, evidence, job, identity).changes === 1
    );
  }
  close(): void {
    this.db.close();
  }
}

/** Exact native builder-run protection, resolved by the engine, not the model. */
export interface ProtectedFoundryBuilder {
  orgId: string;
  agentId: string;
  taskId: string;
  runId: string;
  phaseRef: string;
  policyDigest: string;
  expiresAt: string;
}
export interface ProtectedFoundryEvidence {
  receiptRef: string;
  orgId: string;
  candidateId: string;
  digest: string;
  evaluatorId: string;
  protectionRef: string;
  builderReadable: false;
  builderWritable: false;
  outcome: "PASS" | "FAIL";
  runtimeDigest: string;
  profileDigest: string;
  expiresAt: string;
  canary: { input: unknown; expectedOutputDigest: string };
}
export interface ProtectedFoundryEvaluatorOptions {
  docker: FoundryDockerControl;
  ledger: ProtectedFoundryEvaluationLedger;
  imageId: string;
  seccompPath: string;
  limits: FoundryLimits;
  /** Separate non-root container/UID. The builder cannot reach this callback. */
  authorize(
    version: FoundryFrozenVersion,
    job: string,
    admission: FoundryAdmission,
  ): Promise<ProtectedFoundryBuilder | null>;
  protectionCurrent(proof: ProtectedFoundryBuilder): Promise<boolean>;
  execute(request: FoundryRunnerExecutionRequest, admission: FoundryAdmission): Promise<FoundryExecutionResult>;
  cancel(invocationId: string, fence: number): Promise<{ outcome: string; processTreeTerminated?: boolean }>;
  now?: () => number;
}

export function protectedFoundryEvaluatorIdentity(): string {
  return hashFoundryInput({
    schema: "protected-receipt-evaluator/1",
    programDigest: sha(receiptOracleProgram()),
    uid: 65533,
    maxCases: 32,
    deadlineMs: 90000,
  });
}

export function createProtectedFoundryEvaluator(provided: ProtectedFoundryEvaluatorOptions) {
  const o = Object.freeze({ ...provided, limits: Object.freeze({ ...provided.limits }) });
  const now = o.now ?? Date.now;
  const program = receiptOracleProgram();
  const evaluatorId = `foundry-protected-scorer:${protectedFoundryEvaluatorIdentity()}`;
  const controllers = new Map<string, AbortController>();
  const unknown = (job: string): FoundryEvaluationResult => ({
    outcome: "UNKNOWN_OUTCOME",
    evaluatorJobRef: job,
    receiptRef: null,
    reconciliationRef: job,
  });
  const control = (args: string[]) =>
    o.docker.run(args, { timeoutMs: FOUNDRY_DOCKER_CONTROL_TIMEOUT_MS, stdoutBytes: 8192, stderrBytes: 4096 });
  async function remove(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) return false;
    const r = await control(["rm", "--force", id]);
    return r.exitCode === 0 && !r.timedOut && r.stdout.trim() === id;
  }
  async function authorized(job: string) {
    const row = o.ledger.read(job);
    if (!row || row.phase !== "RUNNING" || !row.context || row.deadline <= now()) return null;
    const context = JSON.parse(row.context) as {
      version: FoundryFrozenVersion;
      admission: FoundryAdmission;
      proof: ProtectedFoundryBuilder;
    };
    const proof = await o.authorize(context.version, job, context.admission);
    if (!proof || hashFoundryInput(proof) !== hashFoundryInput(context.proof)) return null;
    const fresh = o.ledger.read(job);
    return fresh?.phase === "RUNNING" && fresh.deadline > now() ? context : null;
  }
  async function oracle(
    job: string,
    operation: "plan" | "score",
    observations?: unknown[],
  ): Promise<ReceiptOraclePlan | ReceiptOracleVerdict> {
    if (!(await authorized(job))) throw new Error("Evaluation authority unavailable");
    const row = o.ledger.read(job)!;
    const name = `foundry-${sha(`protected-scorer:${job}:${operation}`).slice(0, 48)}`;
    const args = foundryDockerCreateArgs(o, name).map((a) =>
      a === "--reuid=65532" ? "--reuid=65533" : a === "--regid=65532" ? "--regid=65533" : a,
    );
    args[args.length - 1] = program;
    const created = await control(args);
    const id = created.stdout.trim();
    if (created.exitCode !== 0 || !/^[a-f0-9]{64}$/.test(id)) {
      await removeFoundryContainerByName(o.docker, name).catch(() => false);
      throw new Error("Scorer create outcome unknown");
    }
    let removed = false;
    try {
      if (!o.ledger.oracle(job, id) || !(await authorized(job)))
        throw new Error("Evaluation cancelled before scorer start");
      const result = await o.docker.run(["start", "--attach", "--interactive", id], {
        stdin: JSON.stringify({ operation, seed: row.seed, ...(observations ? { observations } : {}) }),
        timeoutMs: o.limits.wallTimeMs - 2000,
        stdoutBytes: 1048576,
        stderrBytes: 4096,
      });
      removed = await remove(id);
      if (!removed || result.exitCode !== 0 || result.timedOut || result.exceeded)
        throw new Error("Protected scorer failed or did not terminate");
      if (!o.ledger.oracle(job, null) || !(await authorized(job))) throw new Error("Evaluator lost authority");
      return JSON.parse(result.stdout) as ReceiptOraclePlan | ReceiptOracleVerdict;
    } finally {
      if (!removed && (await remove(id))) o.ledger.oracle(job, null);
    }
  }
  async function cancelEvaluation(job: string): Promise<FoundryEvaluationCancellationResult> {
    o.ledger.requestCancel(job);
    controllers.get(job)?.abort();
    const row = o.ledger.read(job)!;
    let stopped = !row.oracleContainer || (await remove(row.oracleContainer));
    for (const step of o.ledger.steps(job)) {
      if (step.phase === "TERMINATED") continue;
      const result = await o.cancel(step.invocationId, 1).catch(() => ({ outcome: "UNKNOWN_OUTCOME" }));
      if (result.outcome === "CANCELLED" && "processTreeTerminated" in result && result.processTreeTerminated)
        o.ledger.completeStep(step.invocationId);
      else stopped = false;
    }
    if (!stopped) return unknown(job) as Extract<FoundryEvaluationCancellationResult, { outcome: "UNKNOWN_OUTCOME" }>;
    o.ledger.cancelled(job);
    return {
      outcome: "CANCELLED",
      evaluatorJobRef: job,
      receiptRef: `foundry-protected/cancel/${sha(job)}`,
      processTreeTerminated: true,
    };
  }
  return {
    evaluatorId,
    /** A case can execute only after its protected job persisted that exact
     * input identity; native ownership/lease/policy are rechecked each time. */
    async authorizeCase(request: FoundryRunnerExecutionRequest, admission: FoundryAdmission): Promise<boolean> {
      const step = o.ledger.db
        .query<Step, [string]>("SELECT * FROM protected_evaluation_steps WHERE invocationId=?")
        .get(request.invocationId);
      if (
        !step ||
        step.phase !== "RESERVED" ||
        step.jobRef !== request.nativeDecisionRef ||
        request.budgetReservationRef !== step.invocationId ||
        request.fencingToken !== 1 ||
        step.inputDigest !== request.inputDigest
      )
        return false;
      const context = await authorized(step.jobRef);
      return (
        !!context &&
        context.version.orgId === request.orgId &&
        context.version.digest === request.digest &&
        hashFoundryInput(context.admission) === hashFoundryInput(admission)
      );
    },
    async evaluate(
      version: FoundryFrozenVersion,
      job: string,
      admission: FoundryAdmission,
    ): Promise<FoundryEvaluationReceipt> {
      const proof = await o.authorize(version, job, admission);
      if (
        !proof ||
        !version.dispatchAuthority ||
        proof.orgId !== version.orgId ||
        proof.runId !== version.dispatchAuthority.runId ||
        !/^[a-f0-9]{64}$/.test(proof.policyDigest) ||
        Date.parse(proof.expiresAt) <= now()
      )
        throw new Error("Protected native evaluation authority is missing");
      const context = { version, admission, proof };
      const identity = hashFoundryInput(context);
      const deadline = Math.min(now() + 90000, Date.parse(proof.expiresAt), Date.parse(admission.expiresAt));
      if (!o.ledger.reserve(job, identity, JSON.stringify(context), deadline)) {
        const row = o.ledger.read(job);
        if (row?.identity === identity && row.phase === "TERMINAL" && row.result) return JSON.parse(row.result);
        throw new Error("Evaluation already attempted; reconcile, never replay");
      }
      if (!o.ledger.start(job, identity)) throw new Error("Evaluation cancelled before start");
      const abort = new AbortController();
      controllers.set(job, abort);
      const timer = setTimeout(
        () => {
          void cancelEvaluation(job);
        },
        Math.max(1, deadline - now()),
      );
      try {
        const plan = await oracle(job, "plan");
        if (
          !("cases" in plan) ||
          !Array.isArray(plan.cases) ||
          plan.cases.length < 20 ||
          plan.cases.length > 32 ||
          !/^[a-f0-9]{64}$/.test(plan.fixtureDigest)
        )
          throw new Error("Invalid protected plan");
        const observations: { outcome: string; output?: unknown; code?: string }[] = [];
        const stable = (v: unknown): string =>
          v === null || typeof v !== "object"
            ? JSON.stringify(v)
            : Array.isArray(v)
              ? `[${v.map(stable).join(",")}]`
              : `{${Object.keys(v)
                  .sort()
                  .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
                  .join(",")}}`;
        for (let i = 0; i < plan.cases.length; i++) {
          if (!(await authorized(job))) throw new Error("Evaluation authorization expired");
          const input = plan.cases[i]!.input;
          const invocationId = `foundry-eval:${sha(job)}:${i}`;
          const inputDigest = hashFoundryInput(input);
          if (!o.ledger.step(job, invocationId, inputDigest)) throw new Error("Evaluation case already attempted");
          const r = await o.execute(
            {
              orgId: version.orgId,
              digest: version.digest,
              inputJson: stable(input),
              inputDigest,
              invocationId,
              fencingToken: 1,
              nativeDecisionRef: job,
              budgetReservationRef: invocationId,
              abort: abort.signal,
            },
            admission,
          );
          if (
            r.outcome === "UNKNOWN_OUTCOME" ||
            !r.receipt.processTreeTerminated ||
            r.receipt.orgId !== version.orgId ||
            r.receipt.digest !== version.digest ||
            r.receipt.invocationId !== invocationId ||
            r.receipt.inputDigest !== inputDigest ||
            r.receipt.fencingToken !== 1 ||
            r.receipt.runtimeDigest !== admission.runtimeDigest ||
            r.receipt.profileDigest !== admission.profileDigest ||
            r.receipt.qualificationRef !== admission.attestationRef
          )
            throw new Error("Evaluation execution receipt unverified");
          o.ledger.completeStep(invocationId);
          observations.push(
            r.outcome === "SUCCEEDED" ? { outcome: r.outcome, output: r.output } : { outcome: r.outcome, code: r.code },
          );
        }
        const verdict = await oracle(job, "score", observations);
        if (
          !("outcome" in verdict) ||
          !["PASS", "FAIL"].includes(verdict.outcome) ||
          verdict.fixtureDigest !== plan.fixtureDigest ||
          verdict.casesRun !== plan.cases.length ||
          !verdict.canary ||
          !/^[a-f0-9]{64}$/.test(verdict.canary.expectedOutputDigest)
        )
          throw new Error("Protected verdict malformed");
        if (!(await authorized(job))) throw new Error("Native authority lost before publication");
        const receiptRef = `foundry-protected/receipt/${sha(job)}`;
        const receipt: FoundryEvaluationReceipt = {
          orgId: version.orgId,
          digest: version.digest,
          evaluatorJobRef: job,
          evaluatorRef: evaluatorId,
          runtimeDigest: admission.runtimeDigest,
          profileDigest: admission.profileDigest,
          qualificationRef: admission.attestationRef,
          effectiveLimits: { ...admission.limits },
          outcome: verdict.outcome,
          evidenceRefs: [
            `foundry-protected/holdouts/${verdict.fixtureDigest}`,
            `foundry-protected/program/${sha(program)}`,
          ],
          receiptRef,
          processTreeTerminated: true,
        };
        const evidence: ProtectedFoundryEvidence = {
          receiptRef,
          orgId: version.orgId,
          candidateId: version.candidateId,
          digest: version.digest,
          evaluatorId,
          protectionRef: `native-builder-run:${proof.runId}:${proof.policyDigest}`,
          builderReadable: false,
          builderWritable: false,
          outcome: verdict.outcome,
          runtimeDigest: admission.runtimeDigest,
          profileDigest: admission.profileDigest,
          expiresAt: new Date(Math.min(Date.parse(proof.expiresAt), Date.parse(admission.expiresAt))).toISOString(),
          canary: verdict.canary,
        };
        if (!o.ledger.finish(job, identity, JSON.stringify(receipt), JSON.stringify(evidence)))
          throw new Error("Late evaluator cannot publish");
        return receipt;
      } catch (error) {
        await cancelEvaluation(job).catch(() => undefined);
        throw error;
      } finally {
        clearTimeout(timer);
        controllers.delete(job);
      }
    },
    cancelEvaluation,
    async reconcileEvaluation(job: string): Promise<FoundryEvaluationResult> {
      const row = o.ledger.read(job);
      return row?.phase === "TERMINAL" && row.result ? JSON.parse(row.result) : unknown(job);
    },
    async resolveEvidence(orgId: string, receiptRef: string): Promise<ProtectedFoundryEvidence | null> {
      const rows = o.ledger.db
        .query<Row, [string]>(
          "SELECT * FROM protected_evaluations WHERE phase='TERMINAL' AND json_extract(evidence,'$.receiptRef')=?",
        )
        .all(receiptRef);
      const row = rows.length === 1 ? rows[0] : null;
      if (!row?.evidence || !row.context) return null;
      const evidence = JSON.parse(row.evidence) as ProtectedFoundryEvidence;
      if (evidence.orgId !== orgId || Date.parse(evidence.expiresAt) <= now()) return null;
      const { proof } = JSON.parse(row.context) as { proof: ProtectedFoundryBuilder };
      return (await o.protectionCurrent(proof)) ? evidence : null;
    },
  };
}
