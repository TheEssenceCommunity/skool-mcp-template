/**
 * skool-mcp — stateless MCP server (spec 2026-07-28) on Cloudflare Workers.
 * Endpoint: POST https://<worker>/mcp/<MCP_PATH_SECRET>/<MCP_ADMIN_KEY>
 * Gates (all required): (1) exact secret path, (2) MCP_ADMIN_KEY, presented as the trailing path segment, the `k`
 *        query param, or the `x-api-key` / `x-mcp-key` header, (3) caller IP inside Anthropic's egress range
 *        160.79.104.0/21. Fails closed.
 *        The key is accepted from the URL and not only from a header because Claude's web and mobile connector
 *        settings carry a URL and nothing else — they have no custom-header field, so a header-only gate is
 *        unsatisfiable there and Claude falls back to an OAuth registration this server does not implement.
 *        Local test scripts pass gate 3 only when the Worker var MCP_ALLOW_ANY_IP=1 is set (see wrangler.toml).
 */
import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "./env";
import { buildServer } from "./tools";
import { runHealthcheck, notify } from "./healthcheck";
import { progressStep, progressStatus } from "./progress";

const ANTHROPIC_CIDR = { base: ipv4ToInt("160.79.104.0")!, bits: 21 };

function ipv4ToInt(ip: string): number | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function inCidr(ip: string, cidr: { base: number; bits: number }): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false; // IPv6 or garbage: fail closed
  const size = 2 ** (32 - cidr.bits);
  return n >= cidr.base && n < cidr.base + size;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * If `pathname` is `expected`, returns ""; if it is `expected` + "/" + tail, returns the tail; otherwise null.
 * The prefix is compared in constant time so the path secret cannot be recovered by timing.
 */
function underPath(pathname: string, expected: string): string | null {
  if (timingSafeEqual(pathname, expected)) return "";
  if (pathname.length > expected.length && pathname[expected.length] === "/" && timingSafeEqual(pathname.slice(0, expected.length), expected)) {
    return pathname.slice(expected.length + 1);
  }
  return null;
}

function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok", { headers: { "Cache-Control": "no-store" } });

    if (url.pathname === "/healthcheck") {
      const key = request.headers.get("x-api-key") ?? request.headers.get("x-mcp-key");
      if (!env.MCP_ADMIN_KEY || !key || !timingSafeEqual(key, env.MCP_ADMIN_KEY)) return new Response("not found", { status: 404 });
      if (url.searchParams.get("notify") === "test") {
        const sent = await notify(env, "✅ Skool MCP: Telegram alerts are connected. Daily check runs 08:00 UTC; you only hear from me when something fails.");
        return Response.json({ telegramTestSent: sent });
      }
      return Response.json(await runHealthcheck(env), { headers: { "Cache-Control": "no-store" } });
    }

    // Course-progress collection status, and one step on demand (?step=1) — same key gate as /healthcheck.
    if (url.pathname === "/course-progress") {
      const key = request.headers.get("x-api-key") ?? request.headers.get("x-mcp-key");
      if (!env.MCP_ADMIN_KEY || !key || !timingSafeEqual(key, env.MCP_ADMIN_KEY)) return new Response("not found", { status: 404 });
      const body = url.searchParams.get("step") === "1" ? { step: await progressStep(env), ...(await progressStatus(env)) } : await progressStatus(env);
      return Response.json(body, { headers: { "Cache-Control": "no-store" } });
    }

    const secret = env.MCP_PATH_SECRET;
    const expected = secret ? `/mcp/${secret}` : null;
    if (!expected) return new Response("not found", { status: 404 });
    const tail = underPath(url.pathname, expected);
    if (tail === null) return new Response("not found", { status: 404 });

    const ip = request.headers.get("cf-connecting-ip") ?? "";
    // Every place the key may arrive. URL forms first-class: Claude web/mobile can only configure a URL.
    // `x-api-key` is what Claude desktop's connector settings send; `x-mcp-key` is used by the local test scripts.
    const offered = [
      tail ? safeDecode(tail) : null,
      url.searchParams.get("k"),
      request.headers.get("x-api-key"),
      request.headers.get("x-mcp-key"),
    ];
    const adminKey = env.MCP_ADMIN_KEY;
    const keyOk = !!adminKey && offered.some((candidate) => !!candidate && timingSafeEqual(candidate, adminKey));
    // Both locks: the key must be present AND (the caller is Anthropic OR MCP_ALLOW_ANY_IP is set for local testing).
    if (!keyOk) return new Response("forbidden", { status: 403 });
    if (!inCidr(ip, ANTHROPIC_CIDR) && env.MCP_ALLOW_ANY_IP !== "1") return new Response("forbidden", { status: 403 });

    // The handler matches `route` against the pathname exactly, so hand it the canonical URL with the key stripped.
    const canonical = new URL(request.url);
    canonical.pathname = expected;
    canonical.searchParams.delete("k");
    const routed = canonical.toString() === request.url ? request : new Request(canonical, request);

    const handler = createMcpHandler(() => buildServer(env), { route: expected, corsOptions: false });
    return handler(routed, env, ctx);
  },

  /**
   * ONE cron trigger, every 3 minutes from 06:00 to 08:57 UTC (see wrangler.toml), so the account's 5-trigger free allowance is not touched:
   * the 08:00 UTC run is the daily health check, every other run is a step of the nightly course-progress walk,
   * which exits at once when tonight's walk is already done. Changing the cron string must keep an 08:00 run.
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const at = new Date(event.scheduledTime);
    if (at.getUTCHours() === 8 && at.getUTCMinutes() === 0) ctx.waitUntil(runHealthcheck(env));
    else ctx.waitUntil(progressStep(env, at).then(() => undefined, () => undefined));
  },
};
