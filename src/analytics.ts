/**
 * skool_analytics — everything Skool's admin analytics shows, behind ONE tool whose caller picks what comes back.
 *
 * Sources, all verified live against a real community on 2026-10-10 (from its admin account):
 *   - api2 /groups/{id}/admin-metrics            Admin settings → Dashboard: "Active members" + "Daily activity"
 *   - api2 /groups/{id}/analytics-overview-v2    Dashboard headline: members, MRR (CENTS), retention
 *   - api2 /groups/{id}/analytics-growth-overview-v2   Growth tab headline, last 30 days (new MRR in DOLLARS)
 *   - api2 /groups/{id}/analytics-v2?chart=      the 16 charts (money in DOLLARS)
 *   - next-data {slug}/-/members                 member records: join date, source, referrer, paid tier, departures
 * Screen names and the daily-activity definition come from Skool's own web client (chunk 972, 2026-10-10).
 *
 * Every number goes out labelled with what it is, its time window and the Skool screen it came from, because the
 * same word ("members") means three different counts on three screens — see membersTriple.
 *
 * Budget: a Worker request on the free plan gets 50 subrequests. Every Skool call here is counted against
 * SUBREQUEST_BUDGET (leaving room for the buildId fetch and one retry), and member paging stops cleanly — reporting
 * the result as partial — when the budget or Skool's rate limit says so.
 */
import { SkoolClient, SkoolError } from "./skool";
import type { ProgressSnapshot } from "./progress";

type Json = Record<string, any>;

export const VIEWS = ["overview", "charts", "sources", "members", "paid", "courses", "snapshot"] as const;
export type View = (typeof VIEWS)[number];

export const CHARTS = [
  "members", "mrr", "mrr_cashflow", "mrr_unit", "members_cohorts", "retention_cohorts", "retention_members",
  "conversion_by_day", "conversion_by_source", "conversion_trials", "new_mrr_by_day", "new_mrr_by_source",
  "signups_by_day", "signups_by_source", "visits_by_day", "visits_by_source",
] as const;
export type Chart = (typeof CHARTS)[number];
export const DEFAULT_CHARTS: Chart[] = ["members", "signups_by_source", "visits_by_source", "conversion_by_source"];

export const STATUSES = ["active", "cancelling", "churned", "banned"] as const;
export type Status = (typeof STATUSES)[number];

export const MEMBER_FIELDS = [
  "name", "handle", "userId", "membershipId", "status", "joinedAt", "leftAt", "leftHow", "tier", "priceUsd",
  "interval", "renewsAt", "lifetimePaidUsd", "firstPaidEstimate", "level", "points", "source", "sourceDetail", "referrer",
] as const;
export type MemberField = (typeof MEMBER_FIELDS)[number];
export const DEFAULT_FIELDS: MemberField[] = ["name", "handle", "status", "joinedAt", "tier", "source", "sourceDetail"];

export const MAX_ROWS = 100;
const SUBREQUEST_BUDGET = 45;
const PAGE_SIZE = 30; // Skool's members list, fixed
const PAGE_DELAY_MS = 250;

const DASHBOARD = "Admin settings → Dashboard";
const GROWTH = "Admin settings → Growth (Skool labels the tab \"Last 30 days\")";
const MEMBERS_PAGE = "Members page (admin view)";

const CHART_INFO: Record<Chart, { screen: string; what: string; window: string }> = {
  members: { screen: `${DASHBOARD} → Members`, what: "Members per month: new, existing, churned (negative), total. Totals include admin accounts.", window: "each calendar month since the community started" },
  mrr: { screen: `${DASHBOARD} → MRR`, what: "Monthly recurring revenue and its movements (new, upgrade, downgrade, churn, reactivation), USD", window: "each calendar month" },
  mrr_cashflow: { screen: `${DASHBOARD} → MRR, cash flow`, what: "Money in and out per month: monthly/yearly/one-time payments, Skool+Stripe fees (negative), refunds, disputes, net; USD", window: "each calendar month" },
  mrr_unit: { screen: `${DASHBOARD} → MRR, ARPU / LTV`, what: "Average revenue per user and lifetime value", window: "each calendar month" },
  members_cohorts: { screen: `${DASHBOARD} → Members, cohorts`, what: "Member retention by join-month cohort", window: "monthly cohorts" },
  retention_cohorts: { screen: `${DASHBOARD} → Retention, cohorts`, what: "Paid retention by cohort", window: "monthly cohorts" },
  retention_members: { screen: `${DASHBOARD} → Retention`, what: "Paid-member movements per month (upgrade, downgrade, churn, reactivation) and retention_rate (0–1)", window: "each calendar month" },
  conversion_by_day: { screen: `${GROWTH} → Conversion rate`, what: "About-page visitor → member conversion rate per day (0–1)", window: "last 30 days, daily" },
  conversion_by_source: { screen: `${GROWTH} → Conversion rate, Traffic sources table`, what: "Per traffic source: About-page visitors, signups (num_members) and conversion rate (0–1)", window: "last 30 days (rolling, no date parameter)" },
  conversion_trials: { screen: `${GROWTH} → Conversion rate, trials`, what: "Free-trial conversions", window: "last 30 days" },
  new_mrr_by_day: { screen: `${GROWTH} → New MRR`, what: "New monthly recurring revenue added per day, USD", window: "last 30 days, daily (days with nothing are omitted)" },
  new_mrr_by_source: { screen: `${GROWTH} → New MRR, "Where your new MRR is coming from"`, what: "New MRR per traffic source, USD, with share (0–1)", window: "last 30 days (rolling)" },
  signups_by_day: { screen: `${GROWTH} → Signups`, what: "Signups per day", window: "last 30 days, daily (days with none are omitted)" },
  signups_by_source: { screen: `${GROWTH} → Signups, "Where your signups come from"`, what: "Signups per traffic source, with share (0–1)", window: "last 30 days (rolling; NOT a calendar week)" },
  visits_by_day: { screen: `${GROWTH} → Visitors, "Your about page visitors over time"`, what: "About-page visitors per day", window: "last 30 days, daily" },
  visits_by_source: { screen: `${GROWTH} → Visitors`, what: "About-page visitors per traffic source, with share (0–1)", window: "last 30 days (rolling; NOT a calendar week)" },
};

export interface AnalyticsArgs {
  views: View[];
  charts?: Chart[];
  from?: string;
  to?: string;
  status: Status;
  tier?: "free" | "paid";
  source?: string;
  joinedAfter?: string;
  joinedBefore?: string;
  minLevel?: number;
  fields?: MemberField[];
  limit: number;
  page: number;
  summary: boolean;
  excludeHandles: string[];
  includeNames: boolean;
}

// ---------- small helpers ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return day(d); };
const r1 = (x: number) => Math.round(x * 10) / 10;
const usd = (cents: number) => Math.round(cents) / 100;
const metric = (value: unknown, what: string, window: string, screen: string) => ({ value, what, window, screen });
/** Skool hands back floats like 24.15999984741211; three decimals keeps rates and dollars readable. */
function tidy(v: unknown): unknown {
  if (typeof v === "number" && !Number.isInteger(v)) return Math.round(v * 1000) / 1000;
  if (Array.isArray(v)) return v.map(tidy);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "icon").map(([k, x]) => [k, tidy(x)]));
  return v;
}
function bump(o: Record<string, number>, k: string | null | undefined) { const key = k || "(none recorded)"; o[key] = (o[key] ?? 0) + 1; }
function bumpNested(o: Record<string, Record<string, number>>, a: string | null, b: string | null) { bump((o[a || "(none recorded)"] ??= {}), b); }

class Budget {
  used = 0;
  constructor(readonly max: number) {}
  take(n = 1): boolean { if (this.used + n > this.max) return false; this.used += n; return true; }
}

const BUDGET_STOP = "Cloudflare's per-call subrequest limit (50 on the free plan) — ask for fewer views at once, or narrow the window";
const RATE_STOP = "Skool rate-limited the member-page reads";

// ---------- member records ----------

/** One member record, reduced to what analytics needs. Never carries email (u.email, mbme, searchAnswer) or Stripe ids (msbs). */
interface Rec {
  userId: string; membershipId: string | null; handle: string; name: string; role: string | null; isAdmin: boolean;
  status: Status; joinedAt: string | null; leftAt: string | null; leftHow: string | null; removedBy: string | null;
  tier: "paid" | "free"; tierName: string | null; amountCents: number | null; currency: string | null; interval: string | null;
  renewsAt: string | null; lifetimeCents: number | null; firstPaidEstimate: string | null;
  level: number | null; points: number | null; source: string | null; sourceDetail: string | null;
  referrer: { name: string; handle: string | null; commissionPctAtJoin: number | null } | null;
}

function parse(raw: unknown): Json { if (!raw) return {}; if (typeof raw !== "string") return raw as Json; try { return JSON.parse(raw); } catch { return {}; } }

/**
 * First payment, estimated: renewal date minus (lifetime paid ÷ price) billing intervals. Checked against 4 known
 * upgrade dates on 2026-10-10, all exact to the day. Breaks if the price changed mid-subscription or a payment was
 * refunded, hence "estimate".
 */
function firstPaid(cpeSec: number | undefined, ltv: number | undefined, amount: number | undefined, interval: string | undefined): string | null {
  if (!cpeSec || !ltv || !amount) return null;
  const n = Math.round(ltv / amount);
  const d = new Date(cpeSec * 1000);
  if (interval === "month") d.setUTCMonth(d.getUTCMonth() - n);
  else if (interval === "year") d.setUTCFullYear(d.getUTCFullYear() - n);
  else return null;
  return day(d);
}

export function memberRec(u: Json, status: Status): Rec {
  const mem = u.member ?? {};
  const md = mem.metadata ?? {};
  const sp = parse(u.metadata?.spData ?? u.metadata?.sp_data);
  const plan = md.mmbp ? parse(md.mmbp) : null;
  const afl = u.aflUserData;
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.name;
  return {
    userId: u.id, membershipId: mem.id ?? null, handle: u.name, name, role: mem.role ?? null, isAdmin: mem.role === "group-admin",
    status,
    joinedAt: mem.approvedAt ?? null,
    leftAt: mem.churned ?? null,
    leftHow: md.leftAt ? "left on their own" : md.removedAt ? (md.removedBy ? "removed by an admin" : "removed (Skool recorded no admin)") : null,
    removedBy: md.removedBy ?? null,
    tier: plan ? "paid" : "free",
    tierName: plan?.tier ?? null,
    amountCents: plan?.amount ?? null,
    currency: plan?.currency ?? null,
    interval: plan?.recurring_interval ?? null,
    renewsAt: md.mbscpe ? day(new Date(md.mbscpe * 1000)) : null,
    lifetimeCents: md.mbsltv ?? null,
    firstPaidEstimate: plan ? firstPaid(md.mbscpe, md.mbsltv, plan.amount, plan.recurring_interval) : null,
    level: sp.lv ?? null, points: sp.pts ?? null,
    source: md.attrComp ?? null, sourceDetail: md.attrSrcComp ?? null,
    referrer: md.aflUser ? {
      name: afl ? [afl.firstName, afl.lastName].filter(Boolean).join(" ") || afl.name : md.aflUser,
      handle: afl?.name ?? null,
      commissionPctAtJoin: md.aflPctAtJoin ?? null,
    } : null,
  };
}

function project(r: Rec, fields: MemberField[]): Json {
  const all: Record<MemberField, unknown> = {
    name: r.name, handle: r.handle, userId: r.userId, membershipId: r.membershipId, status: r.status,
    joinedAt: r.joinedAt, leftAt: r.leftAt, leftHow: r.leftHow,
    tier: r.tier === "paid" ? (r.status === "churned" ? "paid (at departure)" : r.tierName ?? "paid") : "free",
    priceUsd: r.amountCents === null ? null : usd(r.amountCents), interval: r.interval, renewsAt: r.renewsAt,
    lifetimePaidUsd: r.lifetimeCents === null ? null : usd(r.lifetimeCents), firstPaidEstimate: r.firstPaidEstimate,
    level: r.level, points: r.points, source: r.source, sourceDetail: r.sourceDetail, referrer: r.referrer,
  };
  return Object.fromEntries(fields.map((f) => [f, all[f]]));
}

const dateOf = (iso: string | null) => (iso ? iso.slice(0, 10) : null);
const inWindow = (iso: string | null, from?: string, to?: string) => { const d = dateOf(iso); return !!d && (!from || d >= from) && (!to || d <= to); };

// ---------- context: one Skool client, one budget, memoised calls shared across views ----------

interface Fetched { recs: Rec[]; total: number | null; totalAdmins: number | null; pagesRead: number; complete: boolean; stoppedBecause?: string }

class Ctx {
  budget = new Budget(SUBREQUEST_BUDGET);
  private memo = new Map<string, Promise<any>>();
  constructor(readonly c: SkoolClient, readonly slug: string, readonly groupId: string) {
    this.budget.take(1); // the buildId fetch behind the first next-data call
  }

  /** A fixed-cost call, made once per request however many views ask for it. Null when the budget is spent. */
  /** Fixed-cost calls refused for budget; their figures come back null and the response says so. */
  skipped: string[] = [];
  once<T>(key: string, cost: number, fn: () => Promise<T>): Promise<T | null> {
    if (!this.memo.has(key)) {
      const ok = this.budget.take(cost);
      if (!ok) this.skipped.push(key);
      this.memo.set(key, ok ? fn() : Promise.resolve(null));
    }
    return this.memo.get(key)!;
  }

  metrics(amt: "daily" | "weekly" | "monthly") { return this.once(`am:${amt}`, 1, () => this.c.adminMetrics(this.groupId, amt)); }
  about() { return this.once("about", 1, () => this.c.groupBySlug(this.slug)); }
  overview() { return this.once("ov", 2, () => this.c.analyticsOverview(this.groupId)); }
  growth() { return this.once("gov", 2, () => this.c.analyticsGrowthOverview(this.groupId)); }
  /** Null only when the budget is spent; a chart with no data (Skool sends items: null) comes back as []. */
  chart(name: Chart) { return this.once(`chart:${name}`, name === "members" ? 1 : 2, async () => (await this.c.analyticsChart(this.groupId, name)) ?? []); }

  /**
   * Page a member list sequentially. `stopAt` relies on the list's order (Active: newest join first; Churned: newest
   * departure first) to stop as soon as everything further is out of range; `enough` stops once the caller has what
   * it needs. A rate limit after the first page ends the read as partial instead of failing the call.
   */
  async members(tab: Status, filters: Record<string, string> = {}, stopAt?: (r: Rec) => boolean, enough?: (recs: Rec[]) => boolean): Promise<Fetched> {
    const recs: Rec[] = [];
    let total: number | null = null, totalAdmins: number | null = null, pagesRead = 0;
    for (let page = 1; ; page++) {
      if (!this.budget.take()) return { recs, total, totalAdmins, pagesRead, complete: false, stoppedBecause: BUDGET_STOP };
      if (page > 1) await sleep(PAGE_DELAY_MS);
      let pp: Json;
      try {
        pp = await this.c.memberList(this.slug, { tab: tab === "active" ? undefined : tab, page, filters });
      } catch (e) {
        if (e instanceof SkoolError && e.kind === "ratelimit" && pagesRead > 0) return { recs, total, totalAdmins, pagesRead, complete: false, stoppedBecause: RATE_STOP };
        throw e;
      }
      pagesRead++;
      total = pp.total ?? total;
      totalAdmins = pp.totalAdmins ?? totalAdmins;
      const users: Json[] = pp.users ?? [];
      for (const u of users) {
        const r = memberRec(u, tab);
        if (stopAt?.(r)) return { recs, total, totalAdmins, pagesRead, complete: true };
        recs.push(r);
      }
      if (users.length < PAGE_SIZE || page >= (pp.totalPages ?? page) || enough?.(recs)) return { recs, total, totalAdmins, pagesRead, complete: true };
    }
  }

  /** Same list read, shared between views that need the same range. */
  membersOnce(key: string, tab: Status, filters: Record<string, string> = {}, stopAt?: (r: Rec) => boolean): Promise<Fetched> {
    if (!this.memo.has(`m:${key}`)) this.memo.set(`m:${key}`, this.members(tab, filters, stopAt));
    return this.memo.get(`m:${key}`)!;
  }
}

const partial = (...fs: Fetched[]) => {
  const bad = fs.find((f) => !f.complete);
  return bad ? { partial: true, partialReason: `Stopped early: ${bad.stoppedBecause}. Counts cover only the pages read.` } : {};
};

// ---------- the three member counts ----------

/** Active-member series and totals come back NEWEST FIRST as {value, time: "YYYY-MM-DDT00:00:00Z"}. */
const seriesAt = (s: Json[] | undefined, date: string) => s?.find((p) => String(p.time).slice(0, 10) === date)?.value ?? null;

async function membersTriple(ctx: Ctx, onDate?: string) {
  const [active, about, daily] = await Promise.all([ctx.membersOnce("active:p1", "active", {}, () => true), ctx.about(), ctx.metrics("daily")]);
  const latest = daily?.total_members?.[0];
  const date = onDate ?? (latest ? String(latest.time).slice(0, 10) : null);
  const dash = date ? seriesAt(daily?.total_members, date) : null;
  const aboutCount = about?.metadata?.total_members ?? null;
  return {
    membersPageActive: metric(active.total, "Active members, NOT counting admin accounts — the number the weekly check-in tracker logs", "now", `${MEMBERS_PAGE} → Active tab`),
    aboutPage: metric(aboutCount, "Members including admin accounts", "now", "About page member count"),
    dashboardDaily: metric(dash, "Skool's daily total, including admin accounts", date ? `Skool's day bucket ${date}` : "unavailable", `${DASHBOARD} (admin-metrics total_members)`),
    adminAccounts: active.totalAdmins,
    whyTheyDiffer:
      "Checked live 2026-10-10 (43 / 44 / 45): the Active tab leaves out admin accounts even though the admin still appears in its list; " +
      "the About page counts them (43 + 1 admin = 44). The Dashboard daily total also counts admins but is a once-a-day snapshot, " +
      "so it had not yet dropped a member who left that afternoon (44 + 1 = 45). Pending join requests were 0, so they were not the cause." +
      (aboutCount !== null && active.total !== null && active.totalAdmins !== null
        ? ` Right now: About − Active = ${aboutCount - active.total}, admin accounts = ${active.totalAdmins}.`
        : ""),
  };
}

// ---------- daily activity ----------

const ACTIVITY_WHAT = "likes + posts + comments + poll votes (Skool's definition of the Daily activity chart) — events, not people";
const ACTIVITY_TZ = "UTC days (Skool's own note on that chart). The active-member series uses Skool's day buckets, which look like the community's local day — do not compare the two day by day.";

/**
 * daily_activities is an unlabelled array: {start_date, end_date, counts[]}. Index i is start_date + i days. Whether
 * end_date is the last bucket is CHECKED here on every call rather than assumed: on 2026-10-10/11 counts.length was 364,
 * exactly the inclusive day span 2025-10-13 → 2026-10-11, so end_date is the last bucket (the current UTC day, partial).
 * If Skool ever sends a length that matches neither reading, the dates are returned flagged as unverified.
 */
export function activityDays(acts: Json | undefined) {
  if (!acts?.counts || !acts.start_date) return null;
  const counts = acts.counts as number[];
  const start = String(acts.start_date).slice(0, 10);
  const end = acts.end_date ? String(acts.end_date).slice(0, 10) : null;
  const span = end ? Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) : null;
  const alignment =
    span === null ? "unverified: Skool sent no end_date"
    : counts.length === span + 1 ? `verified: ${counts.length} counts = the inclusive span ${start} → ${end}, so end_date is the last day`
    : counts.length === span ? `end_date looks EXCLUSIVE (${counts.length} counts = ${start} → day before ${end}); dates still mapped from start_date`
    : `UNVERIFIED: ${counts.length} counts for a ${span}-day span; dates mapped from start_date may be off`;
  return { days: counts.map((count, i) => ({ date: addDays(start, i), count })), alignment, trusted: span !== null && (counts.length === span + 1 || counts.length === span) };
}

// ---------- views ----------

async function overviewView(ctx: Ctx, a: AnalyticsArgs) {
  const [d, w, m, ov, gov] = await Promise.all([ctx.metrics("daily"), ctx.metrics("weekly"), ctx.metrics("monthly"), ctx.overview(), ctx.growth()]);
  const asOf = d?.active_members?.[0] ? String(d.active_members[0].time).slice(0, 10) : null;
  const oldestFirst = (s: Json[] | undefined) => (s ?? []).slice().reverse().map((p) => p.value);
  const series = d?.active_members ?? [];
  const ad = activityDays(d?.daily_activities);
  let activity: Json = { unavailable: true };
  if (ad) {
    const all = ad.days;
    const to = a.to ?? all[all.length - 1]?.date;
    const from = a.from ?? addDays(to, -29);
    const sum = (n: number) => all.slice(-n).reduce((s, x) => s + x.count, 0);
    activity = {
      what: `Activity per day: ${ACTIVITY_WHAT}`,
      screen: `${DASHBOARD} → Daily activity`,
      timezone: ACTIVITY_TZ,
      dateAlignment: ad.alignment,
      note: "The last day is the current UTC day and still filling.",
      window: { from, to },
      days: all.filter((x) => x.date >= from && x.date <= to),
      totals: { last7Days: sum(7), last30Days: sum(30), last365Days: sum(365) },
    };
  }
  return {
    members: await membersTriple(ctx),
    activeMembers: {
      daily: metric(d?.active_members?.[0]?.value ?? null, "Members active that day", asOf ? `day ${asOf}` : "latest day", `${DASHBOARD} → Active members, "Daily active"`),
      weekly: metric(w?.active_members?.[0]?.value ?? null, "Members active in the 7 days up to that day", asOf ? `7 days to ${asOf}` : "latest", `${DASHBOARD} → Active members, "Weekly active"`),
      monthly: metric(m?.active_members?.[0]?.value ?? null, "Members active in the 30 days up to that day", asOf ? `30 days to ${asOf}` : "latest", `${DASHBOARD} → Active members, "Monthly active"`),
      series30Days: {
        what: "Each day's value of the three measures, oldest first",
        window: series.length ? `${String(series[series.length - 1].time).slice(0, 10)} to ${asOf}` : null,
        screen: `${DASHBOARD} → Active members`,
        daily: oldestFirst(d?.active_members), weekly: oldestFirst(w?.active_members), monthly: oldestFirst(m?.active_members),
        totalMembers: oldestFirst(d?.total_members),
      },
    },
    dailyActivity: activity,
    dashboardHeadline: ov ? {
      members: metric(ov.num_members ?? null, "Members including admin accounts", "now", `${DASHBOARD} headline`),
      mrrUsd: metric(ov.mrr === undefined ? null : usd(ov.mrr), "Monthly recurring revenue across ALL paying members (house members included)", "now", `${DASHBOARD} headline (Skool sends cents)`),
      retention: metric(ov.retention ?? null, "Paid retention rate, 0–1", "Skool does not say", `${DASHBOARD} headline`),
    } : { unavailable: BUDGET_STOP },
    growthHeadline: gov ? {
      visitors: metric(gov.num_visitors ?? null, "About-page visitors", "last 30 days (rolling)", `${GROWTH} headline`),
      signups: metric(gov.num_signups ?? null, "Signups", "last 30 days (rolling)", `${GROWTH} headline`),
      newMrrUsd: metric(gov.new_mrr ?? null, "New MRR added", "last 30 days (rolling)", `${GROWTH} headline`),
    } : { unavailable: BUDGET_STOP },
  };
}

async function chartsView(ctx: Ctx, names: Chart[]) {
  const out: Json = {};
  for (const name of names) {
    const info = CHART_INFO[name];
    try {
      const rows = await ctx.chart(name);
      out[name] = rows === null ? { ...info, available: false, reason: BUDGET_STOP } : { ...info, available: true, rows: tidy(rows) };
    } catch (e) {
      if (e instanceof SkoolError && /not_allowed_for_hobby_plan/.test(e.message)) {
        out[name] = { ...info, available: false, reason: "Plan limitation: Skool does not offer this chart on the Hobby plan. Not an error." };
      } else throw e;
    }
  }
  return out;
}

/**
 * Everyone who JOINED in a window, from member records — Active, Churned and Banned tabs, so people who have since
 * left still count. Reads stop at the window's start: Active is newest-join first, Churned newest-departure first
 * (someone who left before `from` joined before it too).
 */
async function joinsAndLeaves(ctx: Ctx, from: string, to: string) {
  const [act, ch, ban] = await Promise.all([
    ctx.membersOnce(`active:>=${from}`, "active", {}, (r) => !!r.joinedAt && dateOf(r.joinedAt)! < from),
    ctx.membersOnce(`churned:>=${from}`, "churned", {}, (r) => !!r.leftAt && dateOf(r.leftAt)! < from),
    ctx.membersOnce("banned", "banned"),
  ]);
  const seen = new Set<string>();
  const all = [...act.recs, ...ch.recs, ...ban.recs].filter((r) => !r.isAdmin && !seen.has(r.userId) && seen.add(r.userId));
  return {
    joined: all.filter((r) => inWindow(r.joinedAt, from, to)).sort((x, y) => (y.joinedAt ?? "").localeCompare(x.joinedAt ?? "")),
    left: ch.recs.filter((r) => inWindow(r.leftAt, from, to)),
    reads: [act, ch, ban],
  };
}

function sourceCounts(recs: Rec[]) {
  const bySource: Record<string, number> = {}, bySourceDetail: Record<string, Record<string, number>> = {}, byReferrer: Record<string, number> = {};
  for (const r of recs) {
    bump(bySource, r.source);
    bumpNested(bySourceDetail, r.source, r.sourceDetail);
    if (r.referrer) bump(byReferrer, r.referrer.name);
  }
  return { bySource, bySourceDetail, byReferrer };
}

async function sourcesView(ctx: Ctx, a: AnalyticsArgs, today: string) {
  const to = a.to ?? today, from = a.from ?? addDays(to, -29);
  const { joined, left, reads } = await joinsAndLeaves(ctx, from, to);
  const byHow: Record<string, number> = {};
  for (const r of left) bump(byHow, r.leftHow);
  return {
    what: "Joins by source, counted from member records (join = approval date). Includes people who have since left. Admin accounts excluded.",
    window: { from, to, days: "UTC" },
    screen: `${MEMBERS_PAGE} — Active, Churned and Banned tabs (member.metadata attrComp / attrSrcComp / aflUser)`,
    sourceKey: "source is Skool's attrComp (direct | skool | external | affiliate | invite); the nested key is attrSrcComp (e.g. instagram.com, discovery_browse_group_link)",
    joined: joined.length,
    ...sourceCounts(joined),
    left: { count: left.length, byHow, what: "Left in the window (Churned tab: left on their own, or removed)" },
    ...partial(...reads),
  };
}

async function membersView(ctx: Ctx, a: AnalyticsArgs) {
  const fields = a.fields?.length ? a.fields : DEFAULT_FIELDS;
  // Server-side tier filters only work on the Active tab (Skool ignores them on Churned). monthly+annual are OR-ed.
  const filters: Record<string, string> = a.status === "active" && a.tier ? (a.tier === "free" ? { free: "true" } : { monthly: "true", annual: "true" }) : {};
  const match = (r: Rec) =>
    !r.isAdmin &&
    (!a.tier || a.status === "active" || r.tier === a.tier) &&
    (!a.source || [r.source, r.sourceDetail].some((s) => s?.toLowerCase() === a.source!.toLowerCase())) &&
    (!a.joinedAfter || (dateOf(r.joinedAt) ?? "") >= a.joinedAfter) &&
    (!a.joinedBefore || (dateOf(r.joinedAt) ?? "9999") <= a.joinedBefore) &&
    (a.minLevel === undefined || (r.level ?? 0) >= a.minLevel);
  // Sorted lists can stop at the first record outside the range.
  const stopAt =
    a.joinedAfter && (a.status === "active" || a.status === "cancelling") ? (r: Rec) => !!r.joinedAt && dateOf(r.joinedAt)! < a.joinedAfter!
    : a.joinedAfter && a.status === "churned" ? (r: Rec) => !!r.leftAt && dateOf(r.leftAt)! < a.joinedAfter!
    : undefined;
  const need = a.page * a.limit;
  // Rows are newest-join first on Active and Cancelling, so a page of rows needs only the pages up to it.
  const enough = !a.summary && (a.status === "active" || a.status === "cancelling") ? (recs: Rec[]) => recs.filter(match).length > need : undefined;
  const f = await ctx.members(a.status, filters, stopAt, enough);
  const hits = f.recs.filter(match).sort((x, y) => (y.joinedAt ?? "").localeCompare(x.joinedAt ?? ""));
  const filtersUsed = { status: a.status, tier: a.tier ?? null, source: a.source ?? null, joinedAfter: a.joinedAfter ?? null, joinedBefore: a.joinedBefore ?? null, minLevel: a.minLevel ?? null };
  const base = {
    what: "Members matching the filters, from member records. Admin accounts excluded.",
    screen: `${MEMBERS_PAGE} → ${a.status[0].toUpperCase()}${a.status.slice(1)} tab`,
    filters: filtersUsed,
    skoolTabTotal: metric(f.total, `Skool's own count for this tab${Object.keys(filters).length ? " and tier filter" : ""} (may include admin accounts when a tier filter is on)`, "now", MEMBERS_PAGE),
    pagesRead: f.pagesRead,
    ...partial(f),
  };
  if (a.summary) {
    const byTier: Record<string, number> = {}, byLevel: Record<string, number> = {}, byJoinMonth: Record<string, number> = {};
    for (const r of hits) { bump(byTier, r.tier); bump(byLevel, r.level === null ? null : `level ${r.level}`); bump(byJoinMonth, r.joinedAt?.slice(0, 7)); }
    return { ...base, matching: hits.length, byTier, ...sourceCounts(hits), byLevel, byJoinMonth };
  }
  const start = (a.page - 1) * a.limit;
  const rows = hits.slice(start, start + a.limit).map((r) => project(r, fields));
  const exhausted = f.complete && !(enough && hits.length > need);
  return {
    ...base,
    sortedBy: "join date, newest first",
    page: a.page, limit: a.limit,
    matching: exhausted ? hits.length : null,
    hasMore: hits.length > start + a.limit || !exhausted,
    rows,
  };
}

/** Paying members = Skool's own monthly/annual billing filter on the Active tab, so a stale plan on a downgraded member cannot leak in. */
async function payers(ctx: Ctx, excludeHandles: string[]) {
  const f = await ctx.membersOnce("paid", "active", { monthly: "true", annual: "true" });
  const ex = new Set(excludeHandles.map((h) => h.toLowerCase()));
  const all = f.recs.filter((r) => !r.isAdmin && r.tier === "paid");
  const excluded = all.filter((r) => ex.has(r.handle.toLowerCase()));
  const counted = all.filter((r) => !ex.has(r.handle.toLowerCase()));
  const found = new Set(all.map((r) => r.handle.toLowerCase()));
  const monthlyCents = counted.reduce((s, r) => s + (r.interval === "year" ? (r.amountCents ?? 0) / 12 : r.interval === "month" ? (r.amountCents ?? 0) : 0), 0);
  return {
    f, counted, excluded,
    notFound: excludeHandles.filter((h) => !found.has(h.toLowerCase())),
    monthlyIncomeUsd: usd(monthlyCents),
    currencies: [...new Set(counted.map((r) => r.currency).filter(Boolean))],
  };
}

async function paidView(ctx: Ctx, a: AnalyticsArgs) {
  const p = await payers(ctx, a.excludeHandles);
  const cancelling = await ctx.membersOnce("cancelling", "cancelling");
  const byTier: Record<string, number> = {}, byInterval: Record<string, number> = {};
  for (const r of p.counted) { bump(byTier, r.tierName); bump(byInterval, r.interval); }
  const out: Json = {
    screen: `${MEMBERS_PAGE} → Active tab, Skool's monthly + annual billing filter`,
    paying: metric(p.counted.length, "Members on a paid monthly or annual plan, minus excludeHandles and admin accounts", "now", MEMBERS_PAGE),
    monthlyIncomeUsd: metric(p.monthlyIncomeUsd, "Sum of their plan prices per month (annual ÷ 12), before Skool and Stripe fees", "now", `${MEMBERS_PAGE} (member.metadata.mmbp)`),
    currencies: p.currencies,
    byTier, byInterval,
    excluded: p.excluded.map((r) => r.name),
    ...(p.notFound.length ? { excludeHandlesNotFound: p.notFound, note: "These handles are not among the paying members (typo, or they are on the free tier)." } : {}),
    cancelling: metric(cancelling.total, "Members whose subscription is set to end (Cancelling tab)", "now", `${MEMBERS_PAGE} → Cancelling tab`),
    firstPaidNote: "firstPaidEstimate = renewal date minus (lifetime paid ÷ price) billing periods; exact on 4 checked upgrades, off if a price changed or a payment was refunded.",
    ...partial(p.f, cancelling),
  };
  if (a.from || a.to) {
    const started = p.counted.filter((r) => inWindow(r.firstPaidEstimate, a.from, a.to));
    out.startedPaying = { what: "Started paying in the window (estimated first payment)", window: { from: a.from ?? null, to: a.to ?? null }, count: started.length, names: started.map((r) => `${r.name} (${r.firstPaidEstimate})`) };
  }
  if (!a.summary) {
    const start = (a.page - 1) * a.limit;
    const fields: MemberField[] = ["name", "handle", "tier", "priceUsd", "interval", "joinedAt", "firstPaidEstimate", "renewsAt", "lifetimePaidUsd", "source"];
    const sorted = p.counted.slice().sort((x, y) => (y.joinedAt ?? "").localeCompare(x.joinedAt ?? ""));
    Object.assign(out, { sortedBy: "join date, newest first", page: a.page, limit: a.limit, hasMore: sorted.length > start + a.limit, rows: sorted.slice(start, start + a.limit).map((r) => project(r, fields)) });
  }
  return out;
}

// ---------- course progress (read from the nightly walk, src/progress.ts) ----------

const COURSES_SCREEN = "Members page → a member's settings → Course access (admin), collected nightly 06:00–08:00 UTC";
const COURSES_WHAT =
  "Lessons completed per member, per course — a COUNT, not which lessons. Skool keeps only the current count, so change over time exists only in saved weekly snapshots. " +
  "How a lesson gets marked done depends on its video (tested 2026-10-11): a video UPLOADED to Skool ticks automatically when the member reaches 90% of it (reaching, not watching: scrubbing counts); " +
  "a YouTube link ticks only when the member presses Done, so counts on those lessons are a floor. Other linked providers (Loom, Vimeo, …) are listed separately under linkedOther and are untested: assume Done-button until checked. " +
  "lessonsByVideo says how many of each a course has.";

function courseSummaries(snap: ProgressSnapshot, excludeHandles: string[]) {
  const ex = new Set(excludeHandles.map((h) => h.toLowerCase()));
  const counted = snap.members.filter((m) => !m.a && !ex.has(m.h.toLowerCase()));
  const courses = snap.courses.map((course) => {
    // A member without access to a course has no entry for it, so they are left out of that course rather than counted as 0.
    const vals = counted.map((m) => m.c?.[course.id]).filter((v): v is number => typeof v === "number").sort((x, y) => x - y);
    const distribution: Record<string, number> = {};
    for (let i = 0; i <= course.lessons; i++) distribution[String(i)] = 0;
    for (const v of vals) distribution[String(v)] = (distribution[String(v)] ?? 0) + 1;
    const mid = vals.length ? (vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2) : null;
    return {
      title: course.title,
      lessons: course.lessons,
      lessonsByVideo: course.videos
        ? { uploaded: course.videos.uploaded, youtube: course.videos.youtube, linkedOther: course.videos.linkedOther, noVideo: course.videos.noVideo }
        : "not collected last night",
      members: vals.length,
      distribution: { what: "members by number of lessons completed (key = lessons done)", counts: distribution },
      started: vals.filter((v) => v >= 1).length,
      finished: course.lessons > 0 ? vals.filter((v) => v >= course.lessons).length : 0,
      medianLessonsCompleted: mid,
    };
  });
  return {
    counted,
    excluded: snap.members.filter((m) => ex.has(m.h.toLowerCase())).map((m) => m.n),
    notFound: excludeHandles.filter((h) => !snap.members.some((m) => m.h.toLowerCase() === h.toLowerCase())),
    courses,
  };
}

const NO_PROGRESS = "No course-progress data yet: it is collected nightly 06:00–08:00 UTC by the Worker's own schedule (no laptop needed). Try again after the next run.";

async function coursesView(ctx: Ctx, a: AnalyticsArgs, load: () => Promise<ProgressSnapshot | null>) {
  const snap = await load();
  if (!snap || snap.community !== ctx.slug) return { unavailable: snap ? `Course progress is collected only for ${snap.community}.` : NO_PROGRESS };
  const s = courseSummaries(snap, a.excludeHandles);
  const out: Json = {
    what: COURSES_WHAT,
    screen: COURSES_SCREEN,
    asOf: snap.takenAt,
    coverage: { membersOnList: snap.membersOnList, membersRead: snap.members.length, readFailures: snap.failed, note: "Admin accounts and excludeHandles are left out of the counts; draft courses are skipped." },
    excluded: s.excluded,
    ...(s.notFound.length ? { excludeHandlesNotFound: s.notFound } : {}),
    courses: s.courses,
  };
  if (!a.summary) {
    const start = (a.page - 1) * a.limit;
    const sorted = s.counted.slice().sort((x, y) => (y.j ?? "").localeCompare(x.j ?? ""));
    Object.assign(out, {
      sortedBy: "join date, newest first", page: a.page, limit: a.limit, hasMore: sorted.length > start + a.limit,
      rows: sorted.slice(start, start + a.limit).map((m) => ({
        name: m.n, handle: m.h, joinedAt: m.j,
        progress: Object.fromEntries(snap.courses.filter((k) => m.c?.[k.id] !== undefined).map((k) => [k.title, `${m.c![k.id]} of ${k.lessons}`])),
      })),
    });
  }
  return out;
}

async function snapshotView(ctx: Ctx, a: AnalyticsArgs, today: string, load: () => Promise<ProgressSnapshot | null>) {
  const to = a.to ?? addDays(today, -1);
  const from = a.from ?? addDays(to, -6);
  const days: string[] = [];
  for (let dd = from; dd <= to && days.length < 31; dd = addDays(dd, 1)) days.push(dd);

  const [d, w, m, ov, visits, signups] = await Promise.all([
    ctx.metrics("daily"), ctx.metrics("weekly"), ctx.metrics("monthly"), ctx.overview(),
    ctx.chart("visits_by_source").catch(() => null), ctx.chart("signups_by_source").catch(() => null),
  ]);
  const dailyValues = days.map((date) => ({ date, value: seriesAt(d?.active_members, date) }));
  const known = dailyValues.map((x) => x.value).filter((v): v is number => typeof v === "number");
  const missing = dailyValues.filter((x) => x.value === null).map((x) => x.date);
  const winLabel = `${from} to ${to}`;

  const [triple, jl, p, cancelling] = await Promise.all([
    membersTriple(ctx, to), joinsAndLeaves(ctx, from, to), payers(ctx, a.excludeHandles), ctx.membersOnce("cancelling", "cancelling"),
  ]);
  const names = (rs: Rec[], extra?: (r: Rec) => string) => (a.includeNames ? { names: rs.map((r) => (extra ? `${r.name} (${extra(r)})` : r.name)) } : {});
  const started = p.counted.filter((r) => inWindow(r.firstPaidEstimate, from, to));
  const leftHow: Record<string, number> = {};
  for (const r of jl.left) bump(leftHow, r.leftHow);

  const progress = await load();
  const cp = progress && progress.community === ctx.slug ? courseSummaries(progress, a.excludeHandles) : null;

  const bySource: Record<string, { visitors: number; joined: number }> = {};
  for (const it of visits ?? []) (bySource[it.attribution] ??= { visitors: 0, joined: 0 }).visitors = it.total ?? 0;
  for (const it of signups ?? []) (bySource[it.attribution] ??= { visitors: 0, joined: 0 }).joined = it.total ?? 0;

  return {
    window: { from, to, note: "Member-record counts use UTC days. Dashboard values are read off Skool's daily buckets exactly as Skool dates them." },
    takenAt: new Date().toISOString(),
    members: triple,
    activeMembers: {
      avgDailyActive: metric(known.length ? r1(known.reduce((s, v) => s + v, 0) / known.length) : null, `Mean of the ${known.length} "Daily active" values in the window`, winLabel, `${DASHBOARD} → Active members, "Daily active"`),
      minDailyActive: metric(known.length ? Math.min(...known) : null, "Lowest single-day value in the window", winLabel, `${DASHBOARD} → Active members`),
      maxDailyActive: metric(known.length ? Math.max(...known) : null, "Highest single-day value in the window", winLabel, `${DASHBOARD} → Active members`),
      weeklyActive: metric(seriesAt(w?.active_members, to), "Members active in the 7 days up to the window's last day", `7 days to ${to}`, `${DASHBOARD} → Active members, "Weekly active"`),
      monthlyActive: metric(seriesAt(m?.active_members, to), "Members active in the 30 days up to the window's last day", `30 days to ${to}`, `${DASHBOARD} → Active members, "Monthly active"`),
      dailyValues,
      ...(missing.length ? { missingDays: missing, missingNote: "Skool keeps only the last 30 days of this series; these days are outside it or not yet bucketed." } : {}),
    },
    weeklyActivity: (() => {
      const ad = activityDays(d?.daily_activities);
      if (!ad) return { unavailable: true };
      const inWin = ad.days.filter((x) => x.date >= from && x.date <= to);
      return {
        ...metric(ad.trusted ? inWin.reduce((s, x) => s + x.count, 0) : null, `Sum over the window of ${ACTIVITY_WHAT}`, `${winLabel}, ${inWin.length} UTC days`, `${DASHBOARD} → Daily activity`),
        // Per UTC day, so a reader can name the busiest day without also asking for the overview view.
        days: ad.trusted ? inWin : null,
        timezone: ACTIVITY_TZ,
        dateAlignment: ad.alignment,
      };
    })(),
    joined: {
      what: "Joined in the window (approval date), including anyone who has already left. Admin accounts excluded.",
      screen: `${MEMBERS_PAGE} — Active, Churned and Banned tabs`,
      count: jl.joined.length,
      alreadyLeft: jl.joined.filter((r) => r.status === "churned").length,
      ...sourceCounts(jl.joined),
      ...names(jl.joined, (r) => [r.source, r.sourceDetail].filter(Boolean).join(" / ") || "source not recorded"),
    },
    left: {
      what: "Left in the window: left on their own, or removed (free members included, not only paid)",
      screen: `${MEMBERS_PAGE} → Churned tab`,
      count: jl.left.length, byHow: leftHow,
      ...names(jl.left, (r) => r.leftHow ?? "unknown"),
    },
    paying: {
      count: metric(p.counted.length, "Paying members (monthly or annual plan), minus excludeHandles and admin accounts", "now", `${MEMBERS_PAGE} → Active tab, billing filter`),
      monthlyIncomeUsd: metric(p.monthlyIncomeUsd, "Their plan prices per month, before Skool and Stripe fees", "now", `${MEMBERS_PAGE} (member plan records)`),
      excluded: p.excluded.map((r) => r.name),
      ...(p.notFound.length ? { excludeHandlesNotFound: p.notFound, note: "Not among the paying members (typo, or on the free tier), so nothing to exclude." } : {}),
      skoolMrrUsd: metric(ov?.mrr === undefined || ov === null ? null : usd(ov.mrr), "Skool's own MRR — counts EVERY payer, house members included", "now", `${DASHBOARD} headline`),
    },
    startedPaying: {
      what: "Started paying in the window (estimated from renewal date and lifetime paid), excluding excludeHandles",
      count: started.length,
      ...names(started, (r) => r.firstPaidEstimate ?? ""),
    },
    cancelling: {
      what: "Subscription set to end", screen: `${MEMBERS_PAGE} → Cancelling tab`,
      count: cancelling.total ?? cancelling.recs.length,
      ...names(cancelling.recs.filter((r) => !r.isAdmin)),
    },
    courseProgress: cp ? {
      what: COURSES_WHAT, screen: COURSES_SCREEN, asOf: progress!.takenAt,
      note: "Counts only. Admin accounts and excludeHandles left out.",
      courses: cp.courses.map(({ title, lessons, lessonsByVideo, members, distribution, started, finished, medianLessonsCompleted }) => ({ title, lessons, lessonsByVideo, members, distribution: distribution.counts, started, finished, medianLessonsCompleted })),
    } : { unavailable: NO_PROGRESS },
    last30DaysBySource: {
      what: "About-page visitors and signups per traffic source. Rolling LAST 30 DAYS ending now — NOT this week; Skool gives no daily split by source.",
      screen: `${GROWTH} → Visitors and Signups, by source`,
      totals: {
        visitors: visits ? visits.reduce((s: number, it: Json) => s + (it.total ?? 0), 0) : null,
        joined: signups ? signups.reduce((s: number, it: Json) => s + (it.total ?? 0), 0) : null,
      },
      bySource,
    },
    ...partial(...jl.reads, p.f, cancelling),
  };
}

// ---------- entry point ----------

export async function runAnalytics(c: SkoolClient, slug: string, groupId: string, a: AnalyticsArgs, loadProgress: () => Promise<ProgressSnapshot | null> = async () => null) {
  const ctx = new Ctx(c, slug, groupId);
  const today = day(new Date());
  const out: Json = { community: slug, generatedAt: new Date().toISOString(), views: a.views };
  // Sequential on purpose: views share memoised calls and one subrequest budget.
  for (const v of a.views) {
    if (v === "overview") out.overview = await overviewView(ctx, a);
    else if (v === "charts") out.charts = await chartsView(ctx, a.charts?.length ? a.charts : DEFAULT_CHARTS);
    else if (v === "sources") out.sources = await sourcesView(ctx, a, today);
    else if (v === "members") out.members = await membersView(ctx, a);
    else if (v === "paid") out.paid = await paidView(ctx, a);
    else if (v === "courses") out.courses = await coursesView(ctx, a, loadProgress);
    else if (v === "snapshot") out.snapshot = await snapshotView(ctx, a, today, loadProgress);
  }
  out.skoolCallsUsed = ctx.budget.used;
  if (ctx.skipped.length) out.incomplete = `Some figures are null because ${BUDGET_STOP} was reached before these reads: ${ctx.skipped.join(", ")}.`;
  return out;
}
