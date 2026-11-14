import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { type Database, eq, schema } from "@agenteschat/db";
import {
  createIssue,
  endWork,
  type IssueStatus,
  moveToBackground,
  postPersonMessage,
  setCriterion,
  setWorkIssueState,
  updateIssue,
} from "../src";
import { type Fixture, setup } from "./fixtures";

setDefaultTimeout(30_000);
let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});
const deps = () => ({ db: f.db, pubsub: f.pubsub });
const owner = () => ({ type: "person" as const, userId: f.owner.id });

async function background(criteria: string[]) {
  f = await setup();
  const issue = await createIssue(deps(), owner(), f.org.id, {
    title: "Verify the deliverable",
    criteria,
    assignee: { type: "agent", id: f.agent.id },
    channelId: f.general.id,
  });
  await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body: "@dev work on #1" });
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("run not started");
  await f.db
    .update(schema.agentRuns)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(schema.agentRuns.id, run.id));
  const moved = await moveToBackground(deps(), run.id, {
    how: "agent",
    title: issue.title,
    say: "Working on it.",
    card: issue.number,
  });
  if (!moved) throw new Error("not background work");
  return { issue, work: moved.work, run: { ...run, workId: moved.work.id } };
}

const readIssue = async (id: string) => (await f.db.select().from(schema.issues).where(eq(schema.issues.id, id)))[0];
const activity = (id: string) => f.db.select().from(schema.issueActivity).where(eq(schema.issueActivity.issueId, id));

test("ending background work does not complete a task with unchecked acceptance criteria", async () => {
  const { issue, run, work } = await background(["Permission granted", "Deliverable verified"]);
  await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, run.id));
  const ended = await endWork(deps(), run, "done");
  expect(ended).toMatchObject({ id: work.id, status: "done" });
  expect(await readIssue(issue.id)).toMatchObject({ status: "in_progress", criteria: issue.criteria });
  expect((await activity(issue.id)).filter((a) => a.event === "status_changed" && a.data.to === "done")).toHaveLength(
    0,
  );
});

const cases: { name: string; checks: boolean[]; status: IssueStatus; expected: IssueStatus }[] = [
  { name: "mixed criteria", checks: [true, false], status: "in_progress", expected: "in_progress" },
  { name: "unchecked todo", checks: [false], status: "todo", expected: "todo" },
  { name: "all checked", checks: [true, true], status: "in_progress", expected: "done" },
  { name: "no criteria", checks: [], status: "in_progress", expected: "done" },
  { name: "review with unchecked criteria", checks: [false], status: "in_review", expected: "in_review" },
  { name: "review with checked criteria", checks: [true], status: "in_review", expected: "in_review" },
  { name: "canceled", checks: [true], status: "canceled", expected: "canceled" },
  { name: "explicit manual done", checks: [false], status: "done", expected: "done" },
];
for (const c of cases) {
  test(`background completion preserves ${c.name}`, async () => {
    const { issue, run } = await background(c.checks.map((_, i) => `Criterion ${i + 1}`));
    for (const [i, checked] of c.checks.entries()) {
      if (checked) await setCriterion(deps(), owner(), f.org.id, issue.id, issue.criteria[i]?.id ?? "", true);
    }
    await updateIssue(deps(), owner(), f.org.id, issue.id, { status: c.status });
    const before = await readIssue(issue.id);
    await endWork(deps(), run, "done");
    expect(await readIssue(issue.id)).toMatchObject({ status: c.expected, criteria: before?.criteria });
    const transitions = (await activity(issue.id)).filter(
      (a) => a.event === "status_changed" && a.data.auto === true && a.data.to === "done",
    );
    expect(transitions).toHaveLength(c.status !== "done" && c.expected === "done" ? 1 : 0);
  });
}

/** Commit an edit immediately before the state update's transaction starts: deterministic freshness, not a parallel lock test. */
function editBeforeTransaction(edit: () => Promise<unknown>): Database {
  return new Proxy(f.db, {
    get(target, property) {
      if (property === "transaction") {
        const transaction: Database["transaction"] = async (fn, config) => {
          await edit();
          return target.transaction(fn, config);
        };
        return transaction;
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("a criterion added before the transaction is read before deciding automatic completion", async () => {
  const { issue, work } = await background([]);
  const db = editBeforeTransaction(() =>
    updateIssue(deps(), owner(), f.org.id, issue.id, { criteria: [{ text: "New verification" }] }),
  );
  await setWorkIssueState({ ...deps(), db }, work, { ended: "done", update: "The turn ended; verification remains." });
  expect(await readIssue(issue.id)).toMatchObject({
    status: "in_progress",
    criteria: [{ text: "New verification", done: false }],
  });
  expect(
    (await activity(issue.id)).some(
      (a) => a.event === "work_update" && a.text === "The turn ended; verification remains.",
    ),
  ).toBe(true);
  expect((await activity(issue.id)).some((a) => a.event === "status_changed" && a.data.to === "done")).toBe(false);
});

test("an authorized agent can still explicitly complete an unchecked task", async () => {
  const { issue, run } = await background(["Unchecked"]);
  await endWork(deps(), run, "done");
  expect((await readIssue(issue.id))?.status).toBe("in_progress");
  await updateIssue(
    deps(),
    { type: "agent", agentId: f.agent.id, channelId: f.general.id, runId: run.id },
    f.org.id,
    issue.id,
    { status: "done" },
  );
  expect((await readIssue(issue.id))?.status).toBe("done");
});

test("a later manual uncheck is outside automatic completion's decision", async () => {
  const { issue, run } = await background(["Checked before completion"]);
  const criterionId = issue.criteria[0]?.id ?? "";
  await setCriterion(deps(), owner(), f.org.id, issue.id, criterionId, true);
  await endWork(deps(), run, "done");
  expect((await readIssue(issue.id))?.status).toBe("done");
  await setCriterion(deps(), owner(), f.org.id, issue.id, criterionId, false);
  expect(await readIssue(issue.id)).toMatchObject({ status: "done", criteria: [{ id: criterionId, done: false }] });
});

for (const status of ["in_review", "canceled", "done"] as const) {
  test(`a late explicit ${status} is preserved`, async () => {
    const { issue, work } = await background([]);
    const db = editBeforeTransaction(() => updateIssue(deps(), owner(), f.org.id, issue.id, { status }));
    await setWorkIssueState({ ...deps(), db }, work, { ended: "done" });
    expect((await readIssue(issue.id))?.status).toBe(status);
    expect(
      (await activity(issue.id)).filter(
        (a) => a.event === "status_changed" && a.data.auto === true && a.data.to === "done",
      ),
    ).toHaveLength(0);
  });
}

for (const ended of ["failed", "canceled"] as const) {
  test(`unchecked criteria keep the existing ${ended} work behavior`, async () => {
    const { issue, run } = await background(["Unchecked"]);
    await endWork(deps(), run, ended);
    expect((await readIssue(issue.id))?.status).toBe(ended === "canceled" ? "todo" : "in_progress");
    if (ended === "failed") expect((await readIssue(issue.id))?.blocked?.reason).toBe("failed");
  });
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// PGlite is a single connection. Only the integration owner's existing PostgreSQL test server can run this.
for (const change of ["criterion", "review"] as const) {
  test.skipIf(!process.env.TEST_DATABASE_URL)(
    `PostgreSQL: concurrent ${change} commits before automatic completion`,
    async () => {
      const { issue, work } = await background([]);
      const locked = signal();
      const release = signal();
      const entered = signal();
      let reader: Promise<void> | undefined;
      const writer = f.db.transaction(async (tx) => {
        await tx
          .update(schema.issues)
          .set(
            change === "criterion"
              ? { criteria: [{ id: crypto.randomUUID(), text: "Concurrent verification", done: false }] }
              : { status: "in_review" },
          )
          .where(eq(schema.issues.id, issue.id));
        locked.resolve();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            release.promise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("completion did not reach its transaction within 10 seconds")),
                10_000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      });
      try {
        await Promise.race([
          locked.promise,
          writer.then(() => {
            throw new Error("writer ended before holding the row");
          }),
        ]);
        const db = editBeforeTransaction(async () => entered.resolve());
        reader = setWorkIssueState({ ...deps(), db }, work, { ended: "done" });
        // On the old implementation, the unlocked issue read already happened before this entry signal.
        // Keep the writer uncommitted until that point; then the new locked read must use its committed edit.
        await Promise.race([
          entered.promise,
          reader.then(() => {
            throw new Error("completion skipped its transaction");
          }),
        ]);
        release.resolve();
        await Promise.all([writer, reader]);
        expect((await readIssue(issue.id))?.status).toBe(change === "criterion" ? "in_progress" : "in_review");
        expect(
          (await activity(issue.id)).some(
            (a) => a.event === "status_changed" && a.data.auto === true && a.data.to === "done",
          ),
        ).toBe(false);
      } finally {
        release.resolve();
        await Promise.allSettled([writer, ...(reader ? [reader] : [])]);
      }
    },
    20_000,
  );
}
