import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { OpenRouterFallbackForm, type OpenRouterFallbackStatus } from "@/components/OpenRouterFallbackCard";
import { createI18n } from "@/i18n";

afterEach(cleanup);
const status: OpenRouterFallbackStatus = {
  serverEnabled: true,
  enabled: false,
  blocked: false,
  monthlyCapNanoUsd: 50e9,
  spentNanoUsd: 12e9,
  heldNanoUsd: 3e9,
  credentialId: null,
  revision: 1,
  period: "2026-11",
  policy: {},
};
function view(s: OpenRouterFallbackStatus, save: (change: unknown) => void) {
  return render(
    <I18nextProvider i18n={createI18n("en")}>
      <OpenRouterFallbackForm
        status={s}
        keys={[{ id: "fixture-key", label: "Dedicated fixture key" }]}
        save={save}
        pending={false}
      />
    </I18nextProvider>,
  );
}
test("shared cap and holds are visible; explicit key and model selection required to enable", async () => {
  const changes: unknown[] = [];
  const r = view(status, (v) => changes.push(v));
  const screen = within(r.container);
  expect(r.container.textContent).toContain("$50.00");
  expect(r.container.textContent).toContain("$3.00");
  const enable = screen.getByRole("button", { name: "Save and enable" }) as HTMLButtonElement;
  expect(enable.disabled).toBe(true);
  await act(async () =>
    fireEvent.change(screen.getByLabelText("Dedicated OpenRouter key"), { target: { value: "fixture-key" } }),
  );
  await act(async () =>
    fireEvent.input(screen.getByLabelText("Allowed concrete model IDs (one per line)"), {
      target: { value: "openai/gpt-6-luna" },
    }),
  );
  expect(enable.disabled).toBe(false);
  await act(async () => fireEvent.submit(enable.closest("form") as HTMLFormElement));
  expect(changes).toMatchObject([
    { enabled: true, credentialId: "fixture-key", policy: { monthlyCapUsd: 50, allowedModels: ["openai/gpt-6-luna"] } },
  ]);
});
test("server disabled state cannot enable paid fallback", () => {
  const changes: unknown[] = [];
  const r = view({ ...status, serverEnabled: false }, (v) => changes.push(v));
  expect(within(r.container).getByRole("status").textContent).toContain("Disabled by server policy");
  expect((within(r.container).getByRole("button", { name: "Save and enable" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(changes).toEqual([]);
});
