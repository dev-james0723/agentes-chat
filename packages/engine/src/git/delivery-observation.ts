/** Bounded identity observations from GitHub's fixed REST origin. No write, trust grant or provider text export. */
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const MAX_BYTES = 128 * 1024;
const MAX_TIMEOUT_MS = 3000;

export class DeliveryObservationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** Only the fetch call used here; native runtimes may expose additional static members such as preconnect. */
export type GithubObservationHttp = (url: string, init?: RequestInit) => Promise<Response>;

export interface GithubObservationDeps {
  http: GithubObservationHttp;
  headers: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  /** Trusted host/test code may shorten the limit, never extend it. */
  timeoutMs?: number;
}

export interface DeliveryRepositoryIdentity {
  id: string;
  host: "github.com";
  owner: string;
  repo: string;
  defaultBranch: string;
}

export interface DeliveryPullObservation {
  repositoryId: string;
  number: number;
  headSha: string;
  baseSha: string;
  baseRef: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  integrationSha: string | null;
}

function fail(code: string): never {
  throw new DeliveryObservationError(code);
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail("delivery_provider_invalid_response");
const providerId = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : fail("delivery_provider_invalid_response");
function branch(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) fail("delivery_provider_invalid_response");
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) fail("delivery_provider_invalid_response");
  }
  return value;
}

/** Response.body and its reader share this member in both Bun and the DOM stream declarations. */
interface CancelableBody {
  cancel(): Promise<void>;
}

function repositoryPath(target: { owner: string; repo: string }) {
  if (!NAME.test(target.owner) || !NAME.test(target.repo)) fail("delivery_repository_invalid");
  return `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
}

async function getJson(deps: GithubObservationDeps, path: string): Promise<Record<string, unknown>> {
  const timeout = deps.timeoutMs ?? MAX_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS)
    fail("delivery_observation_invalid_deadline");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: (() => void) | undefined;
  const stream: { body?: CancelableBody | null; reader?: CancelableBody } = {};
  const stop = new Promise<never>((_resolve, reject) => {
    aborted = () => {
      controller.abort();
      reject(new DeliveryObservationError("delivery_observation_aborted"));
    };
    if (deps.signal?.aborted) {
      aborted();
      return;
    }
    deps.signal?.addEventListener("abort", aborted, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      reject(new DeliveryObservationError("delivery_provider_timeout"));
    }, timeout);
  });
  const read = async () => {
    const url = `https://api.github.com${path}`;
    const response = await deps.http(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { ...deps.headers, accept: "application/vnd.github+json", "user-agent": "agentes.chat" },
    });
    stream.body = response.body;
    // A transport can ignore AbortSignal and resolve after the outer deadline has already returned.
    // That late continuation must discard its body without acquiring a reader or consuming provider text.
    if (controller.signal.aborted) {
      if (response.body) void response.body.cancel().catch(() => {});
      fail("delivery_observation_aborted");
    }
    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400) ||
      (response.url && response.url !== url)
    )
      fail("delivery_provider_redirect");
    if (response.status !== 200) fail("delivery_provider_unavailable");
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))
      fail("delivery_provider_response_too_large");
    const reader = response.body?.getReader();
    if (!reader) fail("delivery_provider_invalid_response");
    stream.reader = reader;
    let total = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > MAX_BYTES) fail("delivery_provider_response_too_large");
        chunks.push(next.value);
      }
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  };
  try {
    return await Promise.race([
      stop,
      Promise.resolve().then(() => {
        if (controller.signal.aborted) fail("delivery_observation_aborted");
        return read();
      }),
    ]);
  } catch (error) {
    if (error instanceof DeliveryObservationError) throw error;
    throw new DeliveryObservationError("delivery_provider_unavailable");
  } finally {
    if (timer) clearTimeout(timer);
    if (aborted) deps.signal?.removeEventListener("abort", aborted);
    controller.abort();
    // Cancellation is best effort and must not extend the observation's deadline.
    if (stream.reader) void stream.reader.cancel().catch(() => {});
    else if (stream.body) void stream.body.cancel().catch(() => {});
  }
}

export async function observeGithubRepository(
  deps: GithubObservationDeps,
  target: { owner: string; repo: string },
): Promise<DeliveryRepositoryIdentity> {
  const row = await getJson(deps, repositoryPath(target));
  const fullName = row.full_name;
  if (typeof fullName !== "string" || fullName.toLowerCase() !== `${target.owner}/${target.repo}`.toLowerCase())
    fail("delivery_repository_identity_mismatch");
  const [owner = "", repo = ""] = fullName.split("/");
  repositoryPath({ owner, repo });
  if (row.archived !== false || row.disabled !== false) fail("delivery_repository_unavailable");
  return { id: providerId(row.id), host: "github.com", owner, repo, defaultBranch: branch(row.default_branch) };
}

export async function observeGithubPull(
  deps: GithubObservationDeps,
  repository: DeliveryRepositoryIdentity,
  number: number,
): Promise<DeliveryPullObservation> {
  if (!Number.isSafeInteger(number) || number <= 0) fail("delivery_pull_invalid");
  const row = await getJson(deps, `${repositoryPath(repository)}/pulls/${number}`);
  const base = object(row.base);
  const head = object(row.head);
  const state = row.state;
  const draft = row.draft;
  const merged = row.merged;
  const headSha = head.sha;
  const baseSha = base.sha;
  if (providerId(object(base.repo).id) !== repository.id) fail("delivery_repository_identity_mismatch");
  if (
    row.number !== number ||
    (state !== "open" && state !== "closed") ||
    typeof draft !== "boolean" ||
    typeof merged !== "boolean" ||
    typeof headSha !== "string" ||
    !SHA.test(headSha) ||
    typeof baseSha !== "string" ||
    !SHA.test(baseSha)
  )
    fail("delivery_provider_invalid_response");
  const integrationSha = row.merge_commit_sha;
  if (integrationSha !== null && (typeof integrationSha !== "string" || !SHA.test(integrationSha)))
    fail("delivery_provider_invalid_response");
  if (merged && !integrationSha) fail("delivery_provider_invalid_response");
  return {
    repositoryId: repository.id,
    number,
    headSha,
    baseSha,
    baseRef: branch(base.ref),
    state,
    draft,
    merged,
    integrationSha,
  };
}
