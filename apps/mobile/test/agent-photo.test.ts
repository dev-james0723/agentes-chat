import { expect, test } from "bun:test";
import { lookOf, rememberAgentLooks } from "../src/agent/looks";
import { photoSource } from "../src/lib/photo";

test("the mobile agent directory keeps the original photo with its fallback look and clears it on removal", () => {
  const look = { id: "accio-mobile-agent", color: "rose", eyes: "happy", accessory: "crown" } as const;
  const avatarUrl = "/api/app/agent-avatars/org/accio-mobile-agent/original.png";
  rememberAgentLooks([{ ...look, avatarUrl }]);
  expect(lookOf(look.id)).toEqual({ ...look, avatarUrl });
  const headers = { Cookie: "session=example", "X-Agentes-Client": "mobile" };
  expect(photoSource(lookOf(look.id)?.avatarUrl, "https://agentes.example", headers)).toEqual({
    uri: `https://agentes.example${avatarUrl}`,
    headers,
  });
  rememberAgentLooks([{ ...look, avatarUrl: null }]);
  expect(lookOf(look.id)).toEqual({ ...look, avatarUrl: null });
  expect(photoSource(lookOf(look.id)?.avatarUrl, "https://agentes.example", headers)).toBeNull();
});
