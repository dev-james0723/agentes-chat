import { earlyAccessToken } from "@agenteschat/client/lib/guards";
import { createFileRoute } from "@tanstack/react-router";
import type { DesktopSignInMethod } from "@/lib/desktop";
import { DesktopSignInPage } from "@/pages/DesktopSignInPage";

const METHODS: DesktopSignInMethod[] = ["google", "github", "apple", "passkey"];

type DesktopSearch = {
  mode?: "passkeys";
  provider?: DesktopSignInMethod;
  request?: string;
  done?: string;
  error?: string;
  access?: string;
};

/** Management is a separate, strictly validated entry on the native shell's already-external route. */
export const Route = createFileRoute("/desktop/sign-in")({
  validateSearch: (search: Record<string, unknown>): DesktopSearch => {
    const empty: DesktopSearch = {
      mode: undefined,
      provider: undefined,
      request: undefined,
      done: undefined,
      error: undefined,
      access: undefined,
    };
    if (search.mode === "passkeys") return { ...empty, mode: "passkeys" };
    // Explicit undefined fields also discard raw search values merged by the router.
    // Unknown modes cannot fall through to a handoff with an otherwise valid request.
    if (search.mode !== undefined) return empty;
    return {
      mode: undefined,
      provider: METHODS.find((method) => method === search.provider),
      request:
        typeof search.request === "string" && /^[A-Za-z0-9_-]{43}$/.test(search.request) ? search.request : undefined,
      done: search.done === "1" || search.done === 1 ? "1" : undefined,
      error: typeof search.error === "string" ? search.error : undefined,
      access: earlyAccessToken(search.access),
    };
  },
  component: function DesktopSignIn() {
    const { mode, provider, request, done, error, access } = Route.useSearch();
    return (
      <DesktopSignInPage
        key={`${mode}:${provider}:${request}:${done}`}
        mode={mode}
        provider={provider}
        request={request}
        done={done === "1"}
        error={error}
        access={access}
      />
    );
  },
});
