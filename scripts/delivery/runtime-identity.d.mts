// Types for runtime-identity.mjs (plain Node, read by the server's parity test).

export interface SourceIdentity {
  digest: string;
  files: number;
}

export type RuntimeCheck =
  | {
      status: "match" | "mismatch";
      revision: string;
      url: string;
      expected: SourceIdentity;
      running: SourceIdentity;
    }
  | { status: "unknown"; reason: string; revision: string; url: string; expected: SourceIdentity; running: null };

export function inSourceScope(path: string): boolean;
export function revisionIdentity(root: string, revision: string): SourceIdentity & { commit: string };
export function checkRuntime(
  root: string,
  revision: string,
  base: string,
  options?: { fetch?: typeof fetch },
): Promise<RuntimeCheck>;
