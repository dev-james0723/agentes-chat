/** Fabricated data only. These cases exercise a projection; they do not grade an LLM's answers. */
export interface Mem0SyntheticStep {
  factId: string;
  sourceId: string;
  text: string;
  revision: number;
  origin: "user_statement" | "user_correction" | "agent_claim" | "derived_export";
  visibility: "public" | "private";
  owner: "owner" | "other";
  status: "current" | "historical";
  operation?: "forget";
}

export interface Mem0SyntheticCase {
  id: string;
  category: "capture" | "correction" | "history" | "provenance" | "privacy" | "forget";
  query: string;
  steps: readonly Mem0SyntheticStep[];
  expectedFactIds: readonly string[];
  queryOwner?: "owner" | "other";
  queryVisibility?: "public" | "private";
  queryStatus?: "current" | "historical";
}

const fact = (id: string, text: string, change: Partial<Mem0SyntheticStep> = {}): Mem0SyntheticStep => ({
  factId: id,
  sourceId: `synthetic-source:${id}:1`,
  text: `Synthetic evaluation only: ${text}`,
  revision: 1,
  origin: "user_statement",
  visibility: "public",
  owner: "owner",
  status: "current",
  ...change,
});

const correction = (id: string, text: string): Mem0SyntheticStep =>
  fact(id, text, { revision: 2, sourceId: `synthetic-source:${id}:2`, origin: "user_correction" });

const cases: Mem0SyntheticCase[] = [
  {
    id: "preferred-name",
    category: "capture",
    query: "What name should I use?",
    steps: [fact("name", "The preferred name is Aster.")],
    expectedFactIds: ["name"],
  },
  {
    id: "response-language",
    category: "capture",
    query: "Which language should responses use?",
    steps: [fact("language", "Use French for responses.")],
    expectedFactIds: ["language"],
  },
  {
    id: "measurement-units",
    category: "capture",
    query: "Which measurement units are preferred?",
    steps: [fact("units", "Use metric units in examples.")],
    expectedFactIds: ["units"],
  },
  {
    id: "response-format",
    category: "capture",
    query: "How should comparisons be formatted?",
    steps: [fact("format", "Use a table when comparing options.")],
    expectedFactIds: ["format"],
  },
  {
    id: "project-status",
    category: "capture",
    query: "Has the Cedar project launched?",
    steps: [fact("project", "Project Cedar is a draft and has not launched.")],
    expectedFactIds: ["project"],
  },
  {
    id: "fresh-reader",
    category: "capture",
    query: "Which editor theme is preferred?",
    steps: [fact("theme", "The preferred editor theme is amber.")],
    expectedFactIds: ["theme"],
  },
  {
    id: "corrected-format",
    category: "correction",
    query: "What is the latest response-length preference?",
    steps: [
      fact("length", "Responses should be concise."),
      correction("length", "Responses should now include detailed reasoning."),
    ],
    expectedFactIds: ["length"],
  },
  {
    id: "corrected-timezone",
    category: "correction",
    query: "Which time zone should the schedule use now?",
    steps: [
      fact("timezone", "Use UTC for the schedule."),
      correction("timezone", "Use Europe/Lisbon for the schedule now."),
    ],
    expectedFactIds: ["timezone"],
  },
  {
    id: "corrected-project-name",
    category: "correction",
    query: "What is the current project name?",
    steps: [
      fact("project-name", "The project is named Pine."),
      correction("project-name", "The project was renamed Birch."),
    ],
    expectedFactIds: ["project-name"],
  },
  {
    id: "out-of-order-source",
    category: "correction",
    query: "Which file format is the current preference?",
    steps: [
      correction("file-format", "The current preferred file format is Markdown."),
      fact("file-format", "The preferred file format is PDF."),
    ],
    expectedFactIds: ["file-format"],
  },
  {
    id: "historical-plan",
    category: "history",
    query: "What was the unapproved plan in April 2025?",
    queryStatus: "historical",
    steps: [
      fact("old-plan", "In April 2025 there was an unapproved plan to visit a fictional observatory.", {
        status: "historical",
      }),
      fact("current-plan", "There is no currently approved observatory visit."),
    ],
    expectedFactIds: ["old-plan"],
  },
  {
    id: "current-vs-old-schedule",
    category: "history",
    query: "Which day is the current review meeting?",
    steps: [
      fact("old-meeting", "The 2024 review meeting was on Tuesday.", { status: "historical" }),
      fact("new-meeting", "The current review meeting is on Thursday."),
    ],
    expectedFactIds: ["new-meeting"],
  },
  {
    id: "agent-claim-not-authority",
    category: "provenance",
    query: "What is the user's stated accent color?",
    steps: [
      fact("color", "The user chose teal."),
      fact("agent-color", "The agent guessed that the user prefers red.", { origin: "agent_claim" }),
    ],
    expectedFactIds: ["color"],
  },
  {
    id: "export-echo-not-correction",
    category: "provenance",
    query: "Which label is current?",
    steps: [
      correction("label", "The current label is Harbor."),
      fact("label", "An old export used Port.", {
        origin: "derived_export",
        revision: 3,
        sourceId: "synthetic-export:copy-of-old-source",
      }),
    ],
    expectedFactIds: ["label"],
  },
  {
    id: "duplicate-source",
    category: "provenance",
    query: "Which review order is preferred?",
    steps: [
      fact("review", "Review correctness before appearance."),
      fact("review", "Review correctness before appearance."),
    ],
    expectedFactIds: ["review"],
  },
  {
    id: "private-relevant-context",
    category: "privacy",
    query: "What is the private fictional project nickname?",
    queryVisibility: "private",
    steps: [fact("nickname", "The private fictional project nickname is Copperleaf.", { visibility: "private" })],
    expectedFactIds: ["nickname"],
  },
  {
    id: "public-context-excludes-private",
    category: "privacy",
    query: "What is the private fictional project nickname?",
    steps: [fact("private-canary", "The private fictional project nickname is Copperleaf.", { visibility: "private" })],
    expectedFactIds: [],
  },
  {
    id: "owner-isolation",
    category: "privacy",
    query: "What is the other owner's project color?",
    queryOwner: "other",
    steps: [fact("owner-canary", "This owner's project color is violet.")],
    expectedFactIds: [],
  },
  {
    id: "forget-removes-result",
    category: "forget",
    query: "What is the fictional project codeword?",
    steps: [
      fact("forgotten", "The fictional project codeword is Lantern."),
      fact("forgotten", "", { operation: "forget" }),
    ],
    expectedFactIds: [],
  },
  {
    id: "forget-blocks-stale-replay",
    category: "forget",
    query: "What is the fictional project codeword?",
    steps: [
      fact("forgotten-replay", "The fictional project codeword is Pebble."),
      fact("forgotten-replay", "", { operation: "forget" }),
      fact("forgotten-replay", "The fictional project codeword is Pebble."),
    ],
    expectedFactIds: [],
  },
];

export const MEM0_SYNTHETIC_CASES: readonly Mem0SyntheticCase[] = Object.freeze(
  cases.map((item) =>
    Object.freeze({
      ...item,
      steps: Object.freeze(item.steps.map((step) => Object.freeze(step))),
      expectedFactIds: Object.freeze(item.expectedFactIds),
    }),
  ),
);
