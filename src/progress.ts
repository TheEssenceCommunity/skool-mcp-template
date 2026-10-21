/**
 * Nightly course-progress collection for skool_analytics' `courses` view and the weekly snapshot.
 *
 * Skool exposes every member's lessons-completed count per course to an admin, but only ONE MEMBER PER CALL
 * (SkoolClient.memberCourseProgress), so a live read costs one subrequest per member — 1,000 at 1,000 members against
 * the free plan's 50 per invocation. Instead the cron trigger walks the member list in steps, every 3 minutes between
 * 06:00 and 08:57 UTC (the 08:00 slot is the health check), keeping its place in KV. Only a COMPLETE walk replaces
 * PROGRESS_KEY, so a reader never sees a half-collected night. The health check alerts when that result is stale.
 *
 * Runs entirely on Cloudflare: no laptop or Claude session involved.
 * KV cost (free plan: 1,000 writes and 100,000 reads a day): one state write per step that did work, plus one result
 * write per night — 3 writes a night for a community of ~50, ~26 at 1,000 members. KV calls do not count toward the
 * 50 external subrequests (they fall under the separate 1,000 "internal services" limit).
 */
import { type Env, defaultProfile, tokenFor } from "./env";
import { SkoolClient, SkoolError } from "./skool";
import { lessonVideoCounts, type VideoCounts } from "./normalize";

type Json = Record<string, any>;

export const PROGRESS_KEY = "course-progress:latest";
const STATE_KEY = "course-progress:walk";
/** Skool calls per step, under the 50-subrequest cap with room for the buildId fetch and a retry. */
const STEP_BUDGET = 46;
/** Results older than this make the health check fail: the walk runs every night, so this means it stalled. */
export const PROGRESS_MAX_AGE_HOURS = 26;
const STATE_TTL_SECONDS = 3 * 86_400;

/** `videos` is the PUBLISHED lessons by how their video is hosted — absent when the outline could not be read that night. */
export interface CourseMeta { id: string; title: string; lessons: number; videos?: VideoCounts }
/** One member. Short keys keep the KV value small at 1,000 members. c = courseId → lessons completed. */
export interface ProgressMember { m: string; h: string; n: string; j: string | null; a: boolean; c?: Record<string, number> }
export interface ProgressSnapshot {
  community: string;
  startedAt: string;
  takenAt: string;
  courses: CourseMeta[];
  members: ProgressMember[];
  membersOnList: number;
  failed: number;
}

interface WalkState {
  day: string;
  phase: "list" | "walk" | "done";
  startedAt: string;
  nextPage: number;
  members: ProgressMember[];
  next: number;
  courses: Record<string, CourseMeta>;
  /** Video counts per published course id, read once per night; `outlinesDone` stops later steps repeating it. */
  outlines?: Record<string, VideoCounts>;
  outlinesDone?: boolean;
  failed: string[];
  lastError?: string;
}

const fresh = (day: string, now: Date): WalkState => ({ day, phase: "list", startedAt: now.toISOString(), nextPage: 1, members: [], next: 0, courses: {}, failed: [] });

/**
 * One step of tonight's walk: list the members (30 per page), then read each one's progress, as far as STEP_BUDGET
 * allows, and save the place. ~50 members take two steps, 3 minutes apart. A rate limit ends the step early and the next
 * step resumes from the same member. Returns a short status for logs and the on-demand route.
 */
export async function progressStep(env: Env, now = new Date()): Promise<Json> {
  const kv = env.PROGRESS;
  if (!kv) return { skipped: "no PROGRESS KV binding configured" };
  const day = now.toISOString().slice(0, 10);
  let st = await kv.get<WalkState>(STATE_KEY, "json");
  if (!st || st.day !== day) st = fresh(day, now);
  if (st.phase === "done") return { day, phase: "done" };

  // The first configured profile: it must be a community admin, the only kind of account Skool lets read others' progress.
  const admin = defaultProfile(env);
  const c = new SkoolClient(tokenFor(admin, env), admin);
  const slug = env.SKOOL_DEFAULT_SLUG, gid = env.SKOOL_DEFAULT_GROUP_ID;
  let budget = STEP_BUDGET;
  let stopped: string | undefined;
  try {
    if (st.phase === "list") budget -= 1; // the buildId fetch behind the first next-data call
    // Once a night: each published course's outline, for lessons-by-video-kind. 1 + 2 calls per course (the course page
    // costs two). It must never stop the walk: a failure is noted and retried on the next step.
    if (st.phase === "list" && !st.outlinesDone) {
      try {
        budget -= 1;
        const found: Record<string, VideoCounts> = {};
        for (const k of await c.classroom(slug)) {
          if (k.state !== 2 || !(Number(k.metadata?.numModules) > 0)) continue;
          if (budget < 2) throw new Error("out of budget for outlines");
          budget -= 2;
          found[k.id] = lessonVideoCounts((await c.coursePage(slug, k.name)).course);
        }
        st.outlines = found;
        st.outlinesDone = true;
      } catch (e) {
        st.lastError = `${new Date().toISOString()} outline read: ${(e as Error).message}`.slice(0, 300);
      }
    }
    while (st.phase === "list" && budget > 0) {
      budget--;
      const pp = await c.memberList(slug, { page: st.nextPage });
      const seen = new Set(st.members.map((x) => x.m));
      for (const u of pp.users ?? []) {
        const mem = u.member ?? {};
        if (!mem.id || seen.has(mem.id)) continue;
        st.members.push({ m: mem.id, h: u.name, n: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.name, j: mem.approvedAt ?? null, a: mem.role === "group-admin" });
      }
      st.nextPage++;
      if (!(pp.users ?? []).length || st.nextPage > (pp.totalPages ?? 0)) st.phase = "walk";
    }
    while (st.phase === "walk" && budget > 0 && st.next < st.members.length) {
      budget--;
      const pm = st.members[st.next];
      try {
        const courses = await c.memberCourseProgress(gid, pm.m);
        pm.c = {};
        for (const k of courses) {
          if (k.state !== 2) continue; // drafts: no user_completed, invisible to members
          const md = k.metadata ?? {};
          st.courses[k.id] ??= { id: k.id, title: md.title ?? k.name, lessons: Number(md.num_modules ?? 0) };
          if (typeof md.user_completed === "number") pm.c[k.id] = md.user_completed;
        }
      } catch (e) {
        if (e instanceof SkoolError && e.kind === "ratelimit") { stopped = "rate limited; resuming next step"; break; }
        st.failed.push(pm.m); // e.g. a member who left mid-walk; counted, not retried
      }
      st.next++;
    }
    if (st.phase === "walk" && st.next >= st.members.length) {
      const snap: ProgressSnapshot = {
        community: slug, startedAt: st.startedAt, takenAt: new Date().toISOString(),
        courses: Object.values(st.courses).map((x) => ({ ...x, ...(st.outlines?.[x.id] ? { videos: st.outlines[x.id] } : {}) })), members: st.members.filter((x) => x.c), membersOnList: st.members.length, failed: st.failed.length,
      };
      await kv.put(PROGRESS_KEY, JSON.stringify(snap));
      st.phase = "done";
    }
  } catch (e) {
    st.lastError = `${new Date().toISOString()} ${(e as Error).message}`.slice(0, 300);
    stopped = st.lastError;
  }
  await kv.put(STATE_KEY, JSON.stringify(st), { expirationTtl: STATE_TTL_SECONDS });
  return { day, phase: st.phase, listed: st.members.length, read: st.next, failed: st.failed.length, callsUsed: STEP_BUDGET - budget, ...(stopped ? { stopped } : {}) };
}

/** The last complete night, or null. */
export async function latestProgress(env: Pick<Env, "PROGRESS">): Promise<ProgressSnapshot | null> {
  return env.PROGRESS ? env.PROGRESS.get<ProgressSnapshot>(PROGRESS_KEY, "json") : null;
}

/** Walk status without doing any work — for the on-demand route. */
export async function progressStatus(env: Env): Promise<Json> {
  if (!env.PROGRESS) return { configured: false };
  const [st, snap] = await Promise.all([env.PROGRESS.get<WalkState>(STATE_KEY, "json"), latestProgress(env)]);
  return {
    configured: true,
    tonight: st ? { day: st.day, phase: st.phase, listed: st.members.length, read: st.next, failed: st.failed.length, lastError: st.lastError ?? null } : null,
    latest: snap ? { takenAt: snap.takenAt, members: snap.members.length, courses: snap.courses.map((x) => x.title) } : null,
  };
}
