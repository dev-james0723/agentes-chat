import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryBlobStore, orgTopic, type RealtimeEvent } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  AVATAR_LIMITS,
  agentAvatarFile,
  agentView,
  createAgent,
  ensureRightHand,
  ForbiddenError,
  getAgent,
  listAgents,
  NotFoundError,
  removeAgentAvatar,
  setAgentAppearance,
  setAgentAvatar,
  ValidationError,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

// Real, complete 1×1 RGBA PNGs with distinct pixels.
const RED = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const BLUE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==";
const input = (data = RED) => ({ data, contentType: "image/png" });
const fileOf = (url: string) => url.split("/").at(-1) as string;

describe("agent portraits", () => {
  test("persists an original portrait without changing the agent's identity, capability fields or fallback", async () => {
    f = await setup();
    const blobs = createMemoryBlobStore();
    const deps = { db: f.db, blobs, pubsub: f.pubsub };
    const look = { color: "teal", eyes: "happy", accessory: "headphones" };
    await setAgentAppearance(f.db, f.owner.id, f.org.id, f.agent.id, look);
    const before = await getAgent(f.db, f.org.id, f.agent.id);
    if (!before) throw new Error("The fixture agent must exist");
    const events: RealtimeEvent[] = [];
    const unsubscribe = f.pubsub.subscribe(orgTopic(f.org.id), (event) => events.push(event));

    const result = await setAgentAvatar(deps, f.owner.id, f.org.id, f.agent.id, input());
    expect(result.avatarUrl).toMatch(
      new RegExp(`^/api/app/agent-avatars/${f.org.id}/${f.agent.id}/[0-9a-f]{16}\\.png$`),
    );
    const current = await getAgent(f.db, f.org.id, f.agent.id);
    if (!current) throw new Error("Uploading a portrait must preserve the agent");
    expect(current).toEqual({ ...before, avatarUrl: result.avatarUrl, updatedAt: current.updatedAt });
    expect(current && agentView(current).avatarUrl).toBe(result.avatarUrl);
    const stored = await agentAvatarFile(deps, f.owner.id, f.org.id, f.agent.id, fileOf(result.avatarUrl));
    expect(stored.contentType).toBe("image/png");
    expect(Buffer.from(stored.body).toString("base64")).toBe(RED);
    expect(
      events.some((e) => e.type === "org.broadcast" && (e.event as { type: string })?.type === "agents.changed"),
    ).toBe(true);
    unsubscribe();

    const [audit] = await f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, "agent.avatar_changed")));
    expect(audit).toMatchObject({
      actorId: f.owner.id,
      targetId: f.agent.id,
      details: { from: null, to: result.avatarUrl },
    });

    // Re-read the persistent record, replace, then remove: the original pixel recipe remains intact.
    const second = await setAgentAvatar(deps, f.owner.id, f.org.id, f.agent.id, input(BLUE));
    expect(second.avatarUrl).not.toBe(result.avatarUrl);
    expect(blobs.objects.size).toBe(1);
    await expect(
      agentAvatarFile(deps, f.owner.id, f.org.id, f.agent.id, fileOf(result.avatarUrl)),
    ).rejects.toBeInstanceOf(NotFoundError);
    await removeAgentAvatar(deps, f.owner.id, f.org.id, f.agent.id);
    const removed = await getAgent(f.db, f.org.id, f.agent.id);
    if (!removed) throw new Error("Removing a portrait must preserve the agent");
    expect(removed).toEqual({ ...before, avatarUrl: null, updatedAt: removed.updatedAt });
    expect(blobs.objects.size).toBe(0);
  });

  test("owner/admin edit rights, same-organization reads and right-hand support", async () => {
    f = await setup();
    const blobs = createMemoryBlobStore();
    const deps = { db: f.db, blobs };
    const member = await addMember(f.db, f.org.id, "member", "reader");
    const outsider = await addUser(f.db, "outsider");
    await expect(setAgentAvatar(deps, member.id, f.org.id, f.agent.id, input())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(removeAgentAvatar(deps, member.id, f.org.id, f.agent.id)).rejects.toBeInstanceOf(ForbiddenError);

    const owned = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Owned", handle: "owned", ownerUserId: member.id },
      { model: "claude-sonnet-5-5" },
    );
    const result = await setAgentAvatar(deps, member.id, f.org.id, owned.id, input());
    expect(await agentAvatarFile(deps, f.owner.id, f.org.id, owned.id, fileOf(result.avatarUrl))).toBeTruthy();
    await expect(
      agentAvatarFile(deps, outsider.id, f.org.id, owned.id, fileOf(result.avatarUrl)),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      agentAvatarFile(deps, member.id, f.org.id, f.agent.id, fileOf(result.avatarUrl)),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      agentAvatarFile(deps, member.id, "bad-org", owned.id, fileOf(result.avatarUrl)),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(agentAvatarFile(deps, member.id, f.org.id, owned.id, "../x.png")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const otherOrg = crypto.randomUUID();
    await expect(setAgentAvatar(deps, member.id, otherOrg, owned.id, input())).rejects.toBeInstanceOf(ForbiddenError);

    await ensureRightHand(f.db, f.org.id);
    const rightHand = (await listAgents(f.db, f.owner.id, f.org.id)).find((agent) => agent.builtin === "right_hand");
    expect(rightHand).toBeTruthy();
    if (!rightHand) throw new Error("The fixture must contain its right hand");
    const before = await getAgent(f.db, f.org.id, rightHand.id);
    if (!before) throw new Error("The right hand must exist before upload");
    const portrait = await setAgentAvatar(deps, f.owner.id, f.org.id, rightHand.id, input());
    const after = await getAgent(f.db, f.org.id, rightHand.id);
    if (!after) throw new Error("Uploading a portrait must preserve the right hand");
    expect(after).toEqual({ ...before, avatarUrl: portrait.avatarUrl, updatedAt: after.updatedAt });
    await removeAgentAvatar(deps, f.owner.id, f.org.id, rightHand.id);
  });

  test("invalid, mismatched, truncated and oversized images leave rows and blobs untouched", async () => {
    f = await setup();
    const blobs = createMemoryBlobStore();
    const deps = { db: f.db, blobs };
    const before = await getAgent(f.db, f.org.id, f.agent.id);
    const original = Buffer.from(RED, "base64");
    const noPixels = Buffer.concat([original.subarray(0, 33), original.subarray(-12)]);
    const corrupt = Buffer.from(original);
    corrupt[41] = (corrupt[41] ?? 0) ^ 0xff;
    const webpHeader = Buffer.alloc(30);
    webpHeader.write("RIFF", 0);
    webpHeader.writeUInt32LE(22, 4);
    webpHeader.write("WEBPVP8X", 8);
    webpHeader.writeUInt32LE(10, 16);
    const badInputs = [
      input("not base64!"),
      input(noPixels.toString("base64")),
      input(corrupt.toString("base64")),
      { data: webpHeader.toString("base64"), contentType: "image/webp" },
      input(Buffer.from("<svg onload='alert(1)'/>").toString("base64")),
      input(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")),
      input(Buffer.from(RED, "base64").subarray(0, 40).toString("base64")),
      { data: RED, contentType: "image/jpeg" },
      input(Buffer.alloc(AVATAR_LIMITS.maxBytes + 1).toString("base64")),
    ];
    for (const bad of badInputs)
      await expect(setAgentAvatar(deps, f.owner.id, f.org.id, f.agent.id, bad)).rejects.toBeInstanceOf(ValidationError);
    expect(await getAgent(f.db, f.org.id, f.agent.id)).toEqual(before);
    expect(blobs.objects.size).toBe(0);
  });

  test("re-uploading identical content keeps its immutable object and does not remove another agent's portrait", async () => {
    f = await setup();
    const blobs = createMemoryBlobStore();
    const deps = { db: f.db, blobs };
    const other = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Other", handle: "other" },
      { model: "claude-sonnet-5-5" },
    );
    const first = await setAgentAvatar(deps, f.owner.id, f.org.id, f.agent.id, input());
    const second = await setAgentAvatar(deps, f.owner.id, f.org.id, other.id, input());
    expect(await setAgentAvatar(deps, f.owner.id, f.org.id, f.agent.id, input())).toEqual(first);
    expect(blobs.objects.size).toBe(2);
    await removeAgentAvatar(deps, f.owner.id, f.org.id, f.agent.id);
    expect(blobs.objects.size).toBe(1);
    expect(await agentAvatarFile(deps, f.owner.id, f.org.id, other.id, fileOf(second.avatarUrl))).toBeTruthy();
  });
});
