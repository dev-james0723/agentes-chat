/**
 * Engineering OS router eval: who answers a message nobody @mentions, in Cantonese (yue), Traditional Chinese
 * (zh-Hant) and mixed Chinese–English, against the James Engineering OS roster as it is in the live database
 * (names, handles, roles, instructions, read once, read-only). Each case runs through the real `routeMessage` on a
 * throw-away in-memory workspace; only the strategy calls out.
 *
 * A case is right when exactly one acceptable agent answers (or nobody, when `want` is empty). Strategies:
 * `rules` (no semantic step: what the router does when every step skips) and `jev` (production). Latency and
 * input tokens are measured per decision.
 *
 *   ROSTER_DATABASE_URL=… EVAL_OUT=/eval/out bun packages/engine/eval/router-engineering-os.ts [--runs 2]
 *
 * The Jev key is the installation's own (`createJevKey`): it is opened in this process and never printed.
 */
import { createDatabase, eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  createAgent,
  createChannel,
  createJevJudge,
  createJevKey,
  createJevRouterStrategy,
  createLocalKeyWrapper,
  DEFAULT_ROUTER_POLICY,
  insertMessage,
  postPersonMessage,
  RouterSkip,
  type RouterStrategy,
  routeMessage,
} from "../src";
import { chooseDelegate, type DelegationPurpose } from "../src/delegation-choice";
import { addMember, setup } from "../test/fixtures";

const ORG = "b221b439-4343-459b-bd26-f2abd0dfe764";

export interface EosCase {
  id: string;
  lang: "yue" | "zh-Hant" | "mix" | "en";
  kind: "direct" | "specialist" | "nobody" | "continuity" | "asks";
  before?: { from: string; text: string }[];
  message: string;
  /** Any one of these, alone, is right; [] means nobody should answer. */
  want: string[];
}

export const EOS_CASES: EosCase[] = [
  {
    id: "yue-kevin-pr",
    lang: "yue",
    kind: "direct",
    message: "Kevin，幫我睇下 PR #482 有冇問題",
    want: ["kevin-frontier-code-reviewer"],
  },
  {
    id: "zh-victor-auth",
    lang: "zh-Hant",
    kind: "direct",
    message: "請 Victor 檢查一下新的登入流程有沒有權限漏洞",
    want: ["victor-security-identity"],
  },
  {
    id: "mix-lily-contrast",
    lang: "mix",
    kind: "direct",
    message: "Lily can you check 個 settings page 嘅 color contrast?",
    want: ["lily-visual-and-accessibility-qa"],
  },
  {
    id: "yue-max-ask-kevin",
    lang: "yue",
    kind: "asks",
    message: "Max，叫 Kevin 幫手 review 埋個 PR",
    want: ["max-engineering-manager"],
  },
  {
    id: "yue-max-who",
    lang: "yue",
    kind: "asks",
    message: "Max，你覺得呢件事應該交畀 Adrian 定 Charlie 做？",
    want: ["max-engineering-manager"],
  },
  {
    id: "yue-voiceover",
    lang: "yue",
    kind: "specialist",
    message: "有冇人可以睇下 iPhone 上面 VoiceOver 讀唔到個 send button？",
    want: ["samuel-mobile-accessibility-and-", "lily-visual-and-accessibility-qa"],
  },
  {
    id: "zh-error-spike",
    lang: "zh-Hant",
    kind: "specialist",
    message: "生產環境的錯誤率突然上升，誰能幫忙查一下？",
    want: ["atlas"],
  },
  {
    id: "mix-prd",
    lang: "mix",
    kind: "specialist",
    message: "邊個可以寫個 PRD for 新嘅 billing feature？",
    want: ["lucas-prd-and-engineering-specif"],
  },
  {
    id: "yue-typo",
    lang: "yue",
    kind: "specialist",
    message: "個 login page 有個 typo，「Pasword」，邊個順手改一改？",
    want: ["ben-maintenance-engineer"],
  },
  {
    id: "zh-brand",
    lang: "zh-Hant",
    kind: "specialist",
    message: "我們需要一套新的品牌視覺識別，有誰可以負責？",
    want: ["isabella-brand-visual", "studio-art-director"],
  },
  {
    id: "yue-release",
    lang: "yue",
    kind: "specialist",
    message: "release 前邊個統籌下 checklist 同 release notes？",
    want: ["ryan-routing-director"],
  },
  {
    id: "mix-harness",
    lang: "mix",
    kind: "specialist",
    message: "Agent 嘅 tool harness 成日 timeout，邊個識整？",
    want: ["mason-platform-harness"],
  },
  {
    id: "yue-skill-coverage",
    lang: "yue",
    kind: "specialist",
    message: "邊個 agent 有 Figma 相關嘅 skill？我想搵人幫手",
    want: ["theodore-skills-and-capability-m"],
  },
  {
    id: "zh-customer-ticket",
    lang: "zh-Hant",
    kind: "specialist",
    message: "客戶回報 app 無法上傳照片，請幫忙整理成工單",
    want: ["nina", "henry-issue-triage"],
  },
  {
    id: "yue-device-regression",
    lang: "yue",
    kind: "specialist",
    message: "要喺實機 iPhone 15 同 Pixel 8 跑一次 regression，邊個得閒？",
    want: ["patrick-physical-device-test-eng", "oscar-device-lab-and-reliability"],
  },
  {
    id: "mix-design-tokens",
    lang: "mix",
    kind: "specialist",
    message: "design system 啲 button component 要改 token，邊個整？",
    want: ["nathan-design-systems-engineer"],
  },
  {
    id: "yue-vector-db-research",
    lang: "yue",
    kind: "specialist",
    message: "幫我研究下市面上有咩 vector database 適合我哋，寫份比較",
    want: ["gabriel-research-analyst", "felix-technical-analyst"],
  },
  {
    id: "zh-deep-debug",
    lang: "zh-Hant",
    kind: "specialist",
    message: "這個 bug 很複雜，涉及並發和記憶體洩漏，需要有人深入除錯",
    want: ["adrian-core-engineer", "daniel-frontier-codex-engineer", "ethan-frontier-claude-engineer"],
  },
  {
    id: "mix-onboarding-ia",
    lang: "mix",
    kind: "specialist",
    message: "新 feature 嘅 onboarding flow 要有人設計 interaction",
    want: ["sophie-product-and-interaction-d"],
  },
  {
    id: "yue-classify-tickets",
    lang: "yue",
    kind: "specialist",
    message: "幫手將呢批 ticket 分類吓，睇邊啲係 bug 邊啲係 feature request",
    want: ["isaac-task-classifier", "henry-issue-triage"],
  },
  {
    id: "mix-independent-verify",
    lang: "mix",
    kind: "specialist",
    message: "Need someone to independently verify the fix before we ship 呀",
    want: ["jacob-quality-reviewer", "kevin-frontier-code-reviewer"],
  },
  {
    id: "yue-new-project",
    lang: "yue",
    kind: "specialist",
    message: "我有個新 project 想開始，要拆 task 同分配人手",
    want: ["max-engineering-manager"],
  },
  {
    id: "mix-motion",
    lang: "mix",
    kind: "specialist",
    message: "啲 motion 動畫 timing 好生硬，邊個可以 polish 下？",
    want: ["studio-motion-craft"],
  },
  { id: "yue-to-walter", lang: "yue", kind: "nobody", message: "Walter，今晚食咩好？", want: [] },
  { id: "yue-laugh", lang: "yue", kind: "nobody", message: "哈哈哈好好笑", want: [] },
  { id: "zh-thanks", lang: "zh-Hant", kind: "nobody", message: "謝謝大家，今天辛苦了", want: [] },
  { id: "yue-later", lang: "yue", kind: "nobody", message: "我遲啲再諗吓", want: [] },
  {
    id: "yue-ben-followup",
    lang: "yue",
    kind: "continuity",
    before: [
      { from: "James", text: "Ben，login page 個 typo 改咗未？" },
      { from: "@ben-maintenance-engineer", text: "改咗喇，已經開咗 PR #490。" },
    ],
    message: "好，咁順手改埋 footer 嗰個",
    want: ["ben-maintenance-engineer"],
  },
  {
    id: "yue-kevin-followup",
    lang: "yue",
    kind: "continuity",
    before: [
      { from: "James", text: "Kevin，PR #482 睇完未？" },
      { from: "@kevin-frontier-code-reviewer", text: "睇完，有兩個小 comment，已經留咗喺 PR。" },
    ],
    message: "OK，咁 merge 得未？",
    want: ["kevin-frontier-code-reviewer"],
  },
];

/** The purpose an agent would give find_agent for the case's task (default implementer). */
/** For task assignment the right agent is who does the work, not who was addressed. */
const DELEGATE_WANT: Record<string, string[]> = {
  "yue-kevin-pr": ["kevin-frontier-code-reviewer", "jacob-quality-reviewer"],
  "yue-max-ask-kevin": ["kevin-frontier-code-reviewer", "jacob-quality-reviewer"],
  "yue-max-who": ["adrian-core-engineer", "charlie-implementation-engineer", "max-engineering-manager"],
};

const PURPOSE: Record<string, DelegationPurpose> = {
  "mix-independent-verify": "independent_reviewer",
  "yue-kevin-pr": "independent_reviewer",
  "yue-new-project": "accountable_delivery_owner",
  "yue-release": "department_coordinator",
};

interface Measured {
  ms: number;
  inputTokens: number | null;
  calls: number;
}

function measured(inner: RouterStrategy, sink: Measured[]): RouterStrategy {
  return {
    name: inner.name,
    on: inner.on?.bind(inner),
    async decide(input) {
      const started = performance.now();
      const m: Measured = { ms: 0, inputTokens: null, calls: 1 };
      current = m;
      try {
        return await inner.decide(input);
      } finally {
        m.ms = Math.round(performance.now() - started);
        sink.push(m);
        current = null;
      }
    },
  };
}
let current: Measured | null = null;

type RosterRow = { name: string; handle: string; role: string | null; instructions: string | null };
async function readRoster(client: NonNullable<ReturnType<typeof createDatabase>["client"]>): Promise<RosterRow[]> {
  return (await client.begin(
    "read only",
    (tx) => tx`
      select name, handle, role, instructions from agents
      where org_id = ${ORG} and archived_at is null and deleted_at is null
        and handle not in ('codex-connection-test', 'lodi')
      order by handle`,
  )) as unknown as RosterRow[];
}

if (import.meta.main) {
  const url = process.env.ROSTER_DATABASE_URL ?? process.env.DATABASE_URL;
  const secret = process.env.AGENTES_SECRET;
  if (!url || !secret) throw new Error("ROSTER_DATABASE_URL/DATABASE_URL and AGENTES_SECRET are required");
  const runs = Number(process.argv.includes("--runs") ? process.argv[process.argv.indexOf("--runs") + 1] : 1);
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1]?.split(",") : null;
  // The live database: the roster and the installation's Jev key are read; nothing is written.
  const live = createDatabase({ url, poolMax: 2 });
  if (!live.client) throw new Error("a PostgreSQL URL is required");
  const roster = await readRoster(live.client);
  const wrapper = createLocalKeyWrapper(secret);
  const jevKey = createJevKey({
    db: live.db,
    keyWrapper: wrapper,
    keyWrappers: [wrapper],
    envKey: process.env.TYPESAFE_API_KEY,
  });
  await jevKey.key();
  if (!jevKey.usable()) throw new Error("the installation's Jev key is not usable");

  const f = await setup();
  await f.db.update(schema.users).set({ name: "James" }).where(eq(schema.users.id, f.owner.id));
  const walter = await addMember(f.db, f.org.id, "member", "Walter");
  const ids = new Map<string, string>();
  for (const a of roster) {
    const agent = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      {
        name: a.name,
        handle: a.handle,
        role: a.role ?? "",
        instructions: a.instructions ?? "",
        credentialId: f.credential.id,
      },
      { model: "claude-sonnet-5-5" },
    );
    ids.set(a.handle, agent.id);
  }
  const handleOf = new Map([...ids].map(([h, id]) => [id, h]));

  const timings: { rules: Measured[]; jev: Measured[] } = { rules: [], jev: [] };
  const rules = measured(
    {
      name: "rules",
      async decide() {
        throw new RouterSkip("rules only");
      },
    },
    timings.rules,
  );
  const jev = measured(
    createJevRouterStrategy({
      key: jevKey,
      timeoutMs: 10_000,
      recordUsage: async (u) => {
        if (current) current.inputTokens = u.inputTokens;
        return undefined;
      },
    }),
    timings.jev,
  );

  let n = 0;
  async function run(c: EosCase, strategy: RouterStrategy) {
    n += 1;
    const channel = await createChannel(f.db, f.owner.id, f.org.id, { name: `eos-${n}` });
    await addChannelMember(f.db, f.owner.id, f.org.id, channel.id, { userId: walter.id });
    for (const id of ids.values()) await addChannelMember(f.db, f.owner.id, f.org.id, channel.id, { agentId: id });
    const now = Date.now();
    const lines = c.before ?? [];
    for (const [i, line] of lines.entries()) {
      const agentId = line.from.startsWith("@") ? ids.get(line.from.slice(1)) : undefined;
      await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: channel.id,
        threadId: null,
        author: agentId
          ? { type: "agent", agentId, runId: null, hop: 1, stretchId: null }
          : { type: "person", userId: line.from === "Walter" ? walter.id : f.owner.id },
        body: line.text,
        createdAt: new Date(now - (lines.length - i) * 60_000),
      });
    }
    const message = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, channel.id, {
      body: c.message,
    });
    const routed = await routeMessage(
      { db: f.db, strategy, policy: { ...DEFAULT_ROUTER_POLICY, maxHops: 3 } },
      { orgId: f.org.id, messageId: message.id },
    );
    const [decision] = await f.db
      .select()
      .from(schema.routingDecisions)
      .where(eq(schema.routingDecisions.messageId, message.id));
    const picked = (routed.selected ?? []).map((id) => handleOf.get(id) ?? id);
    const ok = c.want.length === 0 ? picked.length === 0 : picked.length === 1 && c.want.includes(picked[0] ?? "");
    const verdict = ok
      ? "right"
      : picked.length === 0
        ? "missed"
        : c.want.length === 0
          ? "false_wake"
          : picked.some((p) => c.want.includes(p))
            ? "extra_agents"
            : "wrong_agent";
    return {
      id: c.id,
      lang: c.lang,
      kind: c.kind,
      want: c.want,
      picked,
      verdict,
      reason: decision?.reason ?? decision?.error ?? null,
    };
  }

  const cases = EOS_CASES.filter((c) => !only || only.includes(c.id));

  // Task assignment: what find_agent now does with a task and no named target (Jev over every eligible agent).
  const judge = createJevJudge({ key: jevKey, gateway: { recordExternalUsage: async () => null }, timeoutMs: 6000 });
  const roles = new Map(roster.map((a) => [a.handle, a]));
  const candidates = [...ids].map(([handle, id]) => ({
    id,
    handle,
    name: roles.get(handle)?.name ?? handle,
    role: roles.get(handle)?.role ?? "",
    about: (roles.get(handle)?.instructions ?? "").slice(0, 300),
    can: "",
    presence: "online",
  }));
  const delegation: { id: string; lang: string; want: string[]; picked: string | null; status: string; ms: number }[] =
    [];
  for (let r = 0; r < runs; r++)
    for (const c of cases.filter((x) => x.want.length > 0 && x.kind !== "continuity")) {
      const started = performance.now();
      const d = await chooseDelegate(
        judge,
        { orgId: f.org.id, agentId: crypto.randomUUID(), runId: crypto.randomUUID() },
        c.message,
        candidates,
        PURPOSE[c.id] ?? "implementer",
      );
      const picked = d.status === "recommended" && "handle" in d ? (d.handle as string) : null;
      const want = DELEGATE_WANT[c.id] ?? c.want;
      const row = {
        id: c.id,
        lang: c.lang,
        want,
        picked,
        status: d.status,
        ms: Math.round(performance.now() - started),
      };
      delegation.push(row);
      console.log(
        `deleg#${r + 1} ${picked && want.includes(picked) ? "right" : "WRONG"}  ${c.lang.padEnd(7)} ${c.id.padEnd(24)} → ${picked ?? d.status}`,
      );
    }
  const results: Record<string, unknown[]> = {};
  for (const [label, strategy, times] of [
    ["rules", rules, 1],
    ["jev", jev, runs],
  ] as const) {
    for (let r = 0; r < times; r++) {
      const key = times > 1 ? `${label}#${r + 1}` : label;
      results[key] = [];
      for (const c of cases) {
        const res = await run(c, strategy);
        results[key]?.push(res);
        console.log(
          `${key.padEnd(7)} ${res.verdict.padEnd(12)} ${c.lang.padEnd(7)} ${c.id.padEnd(24)} → ${res.picked.join(",") || "nobody"}  ${res.reason ?? ""}`,
        );
      }
    }
  }
  const summary = Object.fromEntries(
    Object.entries(results).map(([k, rs]) => {
      const list = rs as { verdict: string; kind: string }[];
      const count = (v: string) => list.filter((x) => x.verdict === v).length;
      return [
        k,
        {
          n: list.length,
          right: count("right"),
          missed: count("missed"),
          wrong_agent: count("wrong_agent"),
          extra_agents: count("extra_agents"),
          false_wake: count("false_wake"),
        },
      ];
    }),
  );
  const stat = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length
      ? {
          n: s.length,
          p50: s[Math.floor(s.length / 2)],
          p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))],
          max: s[s.length - 1],
        }
      : null;
  };
  const jevTokens = timings.jev.map((t) => t.inputTokens).filter((x): x is number => x !== null);
  const report = {
    at: new Date().toISOString(),
    roster: roster.length,
    cases: cases.length,
    summary,
    latencyMs: { rules: stat(timings.rules.map((t) => t.ms)), jev: stat(timings.jev.map((t) => t.ms)) },
    jevInputTokens: stat(jevTokens),
    jevCostUsd: Math.round(jevTokens.reduce((a, b) => a + b, 0) * 42) / 1e9,
    delegation: {
      n: delegation.length,
      right: delegation.filter((d) => d.picked && d.want.includes(d.picked)).length,
      latencyMs: stat(delegation.map((d) => d.ms)),
      rows: delegation,
    },
    results,
  };
  console.log(
    JSON.stringify(
      {
        summary,
        latencyMs: report.latencyMs,
        jevInputTokens: report.jevInputTokens,
        jevCostUsd: report.jevCostUsd,
        delegation: { n: report.delegation.n, right: report.delegation.right, latencyMs: report.delegation.latencyMs },
      },
      null,
      2,
    ),
  );
  if (process.env.EVAL_OUT)
    await Bun.write(`${process.env.EVAL_OUT}/router-eos-${Date.now()}.json`, JSON.stringify(report, null, 2));
  await f.close();
  await live.client.end({ timeout: 5 });
  process.exit(0);
}
