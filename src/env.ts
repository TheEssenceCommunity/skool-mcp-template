/** Worker bindings. Tokens and keys are secrets (wrangler secret put); the rest are [vars] in wrangler.toml. */
export interface Env {
  SKOOL_DEFAULT_SLUG: string;
  SKOOL_DEFAULT_GROUP_ID: string;
  /**
   * The Skool accounts this server can act as, comma-separated, each optionally with a short description after a colon:
   * "main" or "main:The community's admin account, cohost:My co-host". The FIRST is the default for reads and the
   * account the health check, analytics and nightly course-progress walk use, so list the community admin first.
   * Each needs a secret SKOOL_TOKEN_<NAME> (name upper-cased). Unset = one profile called "main".
   */
  SKOOL_PROFILES?: string;
  /** Unguessable path segment: the MCP endpoint lives at /mcp/<MCP_PATH_SECRET>. */
  MCP_PATH_SECRET?: string;
  /** Required on every MCP request as `x-api-key` (Claude connector) or `x-mcp-key` (local scripts). */
  MCP_ADMIN_KEY?: string;
  /** "1" lets requests from outside Anthropic's IP range in (they still need the key). For local testing only. */
  MCP_ALLOW_ANY_IP?: string;
  /** Optional: daily health-check alerts go to this Telegram chat. */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  /** Optional override for GIF search. Defaults to the key Skool's own web client ships. See SkoolClient.searchGifs. */
  GIPHY_KEY?: string;
  /** KV store for the nightly course-progress walk (src/progress.ts). Optional: without it the courses view says so. */
  PROGRESS?: KVNamespace;
  /** One Skool session cookie per profile: SKOOL_TOKEN_MAIN, SKOOL_TOKEN_COHOST, … */
  [token: `SKOOL_TOKEN_${string}`]: string | undefined;
}

/** A profile name from SKOOL_PROFILES. */
export type Profile = string;
export interface ProfileInfo { name: Profile; description: string }

/** The configured profiles, in order; never empty. Names are lower-case letters, digits and underscores. */
export function profilesOf(env: Pick<Env, "SKOOL_PROFILES">): [ProfileInfo, ...ProfileInfo[]] {
  const out: ProfileInfo[] = [];
  for (const raw of (env.SKOOL_PROFILES ?? "").split(",")) {
    const [n, ...rest] = raw.split(":");
    const name = n.trim().toLowerCase();
    if (!name) continue;
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`SKOOL_PROFILES: "${name}" is not a valid profile name (use a-z, 0-9 and _ only).`);
    if (!out.some((p) => p.name === name)) out.push({ name, description: rest.join(":").trim() });
  }
  return out.length ? (out as [ProfileInfo, ...ProfileInfo[]]) : [{ name: "main", description: "" }];
}

/** The profile reads default to and admin-only background jobs run as: the first in SKOOL_PROFILES. */
export const defaultProfile = (env: Pick<Env, "SKOOL_PROFILES">): Profile => profilesOf(env)[0].name;

export function tokenFor(profile: Profile, env: Env): string {
  const key = `SKOOL_TOKEN_${profile.toUpperCase()}` as const;
  const token = env[key];
  if (typeof token !== "string" || !token) {
    throw new Error(`Profile "${profile}" has no Skool token configured (Worker secret ${key} is missing).`);
  }
  return token;
}
