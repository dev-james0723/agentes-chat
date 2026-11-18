import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import {
  addChannelMember,
  createContextToolSource,
  drainOutbox,
  insertMessage,
  openDm,
  type ToolContext,
  type ToolDefinition,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** A run of @dev on `triggerId` in `channelId`, as the dispatcher starts one. */
async function runOn(channelId: string, triggerId: string, background = false): Promise<ToolContext> {
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId,
      threadRootId: triggerId,
      triggerMessageId: triggerId,
      trigger: "mention",
      hop: 1,
      status: "running",
      background,
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId,
    threadRootId: triggerId,
    triggerMessageId: triggerId,
  };
}

async function call(ctx: ToolContext, name: string, input: Record<string, unknown>) {
  const all: ToolDefinition[] = await createContextToolSource(f.context).tools(ctx);
  const tool = all.find((t) => t.name === name);
  if (!tool) throw new Error(`no ${name}`);
  return tool.execute(input, ctx);
}

const asked = (userId: string, body: string, meta?: Record<string, unknown>) =>
  insertMessage(f.db, { orgId: f.org.id, channelId: f.general.id, author: { type: "person", userId }, body, meta });

describe("private recall stays within the answer audience", () => {
  async function world() {
    f = await setup({ reply: () => ({ chunks: ["Anotado."] }) });
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const said = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: dm.id,
      author: { type: "person", userId: f.owner.id },
      body: "o deploy da vitrine foi adiado para segunda",
    });
    await drainOutbox(f.db, f.handlers);
    return { bia, dm, said };
  }

  test("the requester, another member and a routine cannot bring a private DM into a public answer", async () => {
    const { bia, dm, said } = await world();
    const mine = await runOn(f.general.id, (await asked(f.owner.id, "@dev já te falei da vitrine?")).id);
    const found = await call(mine, "search_context", { query: "deploy vitrine adiado" });
    expect(found.content).not.toContain("adiado para segunda");
    expect(found.content).not.toContain("your DM with");
    expect(found.content).not.toContain(said.id);
    const privateRun = await runOn(
      dm.id,
      (
        await insertMessage(f.db, {
          orgId: f.org.id,
          channelId: dm.id,
          author: { type: "person", userId: f.owner.id },
          body: "Please recall the deployment.",
        })
      ).id,
    );
    expect((await call(privateRun, "search_context", { query: "deploy vitrine adiado" })).content).toContain(
      "adiado para segunda",
    );

    const theirs = await runOn(f.general.id, (await asked(bia.id, "@dev já falaram da vitrine?")).id);
    expect((await call(theirs, "search_context", { query: "deploy vitrine adiado" })).content).not.toContain(
      "adiado para segunda",
    );

    const routine = await runOn(f.general.id, (await asked(f.owner.id, "resumo diário")).id, true);
    expect((await call(routine, "search_context", { query: "deploy vitrine adiado" })).content).not.toContain(
      "adiado para segunda",
    );
  });

  test("read_conversation refuses public disclosure and retains direct private access", async () => {
    const { bia, dm, said } = await world();
    const mine = await runOn(f.general.id, (await asked(f.owner.id, "@dev o que eu te disse?")).id);
    const read = await call(mine, "read_conversation", { message: said.id });
    expect(read.isError).toBe(true);
    expect(read.content).not.toContain("adiado para segunda");
    expect(
      (
        await call(
          await runOn(
            dm.id,
            (
              await insertMessage(f.db, {
                orgId: f.org.id,
                channelId: dm.id,
                author: { type: "person", userId: f.owner.id },
                body: "Please recall the deployment.",
              })
            ).id,
          ),
          "read_conversation",
          { message: said.id },
        )
      ).content,
    ).toContain("adiado para segunda");
    const theirs = await runOn(f.general.id, (await asked(bia.id, "@dev o que ele disse?")).id);
    expect((await call(theirs, "read_conversation", { message: said.id })).isError).toBe(true);
    // Words read from outside (a page, an email) are no one's own: nothing extra.
    const relayed = await runOn(
      f.general.id,
      (await asked(f.owner.id, "@dev resume a página", { readOutside: true })).id,
    );
    expect((await call(relayed, "read_conversation", { message: said.id })).isError).toBe(true);
  });
});
