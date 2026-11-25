import { join } from "node:path";

export type OpencodeMajor = 1 | 2;

/** Only CLI releases whose argv and permission output we understand. */
export function opencodeMajor(output: string): OpencodeMajor | undefined {
  const major = /^(?:opencode )?v?([12])\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.exec(output.trim())?.[1];
  return major === "1" ? 1 : major === "2" ? 2 : undefined;
}

/** The free provider needs no sign-in. Build its environment from scratch so new key and config variables stay out. */
export function opencodeFreeEnv(home: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP", "SystemRoot"]) {
    if (base[key]) env[key] = base[key];
  }
  const config = join(home, "config");
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_STATE_HOME: join(home, "state"),
    OPENCODE_CONFIG_DIR: config,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      enabled_providers: ["opencode"],
      permission: { "*": "deny" },
      share: "disabled",
      autoupdate: false,
    }),
  };
}
