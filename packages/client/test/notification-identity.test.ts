import { describe, expect, test } from "bun:test";
import type { AppNotification } from "../src/api/types";
import { notificationSourceLabel } from "../src/lib/notifications";

type Notice = Pick<AppNotification, "kind" | "source" | "latest">;
const nameOf = (id: string) => (id === "agent-1" ? "Elliott | Inbox and Correspondence" : undefined);

describe("notification identity labels", () => {
  test("known agent-name kinds resolve the current name by ID without changing stored history", () => {
    const notices: Notice[] = [
      { kind: "browser_profile_request", source: { agentId: "agent-1", label: "Clara" }, latest: {} },
      { kind: "desktop_taken", source: { agentId: "agent-1", label: "Clara" }, latest: {} },
      { kind: "plan_lent", source: { agentId: "agent-1", label: "Clara" }, latest: {} },
      { kind: "change_request", source: { agentId: "agent-1", proposalId: "proposal-1", label: "Clara" }, latest: {} },
      { kind: "org_standing", source: { agentId: "agent-1", label: "Clara" }, latest: { statusTo: "agent_hold" } },
    ];
    const before = structuredClone(notices);
    for (const notice of notices) expect(notificationSourceLabel(notice, nameOf)).toBe(nameOf("agent-1"));
    expect(notices).toEqual(before);
  });

  test("a new-agent draft and an action name are not the proposing agent's name", () => {
    for (const source of [
      { agentId: "agent-1", label: "New assistant", messageId: "new-agent" },
      { agentId: "agent-1", label: "Rename workspace", messageId: "action", action: "workspace_rename" },
    ]) {
      expect(notificationSourceLabel({ kind: "change_request", source, latest: {} }, nameOf)).toBe(source.label);
    }
  });

  test("thread, skill and workspace labels keep their own meaning even with an agent ID", () => {
    for (const kind of ["thread_reply", "agent_reply", "skill_update", "org_standing"] as const) {
      expect(
        notificationSourceLabel(
          {
            kind,
            source: { agentId: "agent-1", label: "Clara's travel notes" },
            latest: {},
          },
          nameOf,
        ),
      ).toBe("Clara's travel notes");
    }
  });

  test("missing or inaccessible IDs retain the stored label", () => {
    for (const source of [{ label: "Former colleague" }, { agentId: "unknown", label: "Former colleague" }]) {
      expect(notificationSourceLabel({ kind: "plan_lent", source, latest: {} }, nameOf)).toBe("Former colleague");
    }
    expect(notificationSourceLabel({ kind: "plan_lent", source: {}, latest: {} }, nameOf)).toBeUndefined();
  });
});
