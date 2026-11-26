import { RemoteError } from "./cloudflare.mjs";

// 7-day Visits and Page views (D5, 0.6.0) from the GraphQL Analytics API,
// cached in SQLite. Cookie-free Web Analytics counts visits, not visitors.
// One query covers every site of the account; the background round asks at
// most every 30 minutes, a manual refresh at most once a minute, well inside
// the 300 queries per 5 minutes Cloudflare allows. A token without Account
// Analytics: Read never fails the page: Sites says what to add.
//
// The field names (rumPageloadEventsAdaptiveGroups, count, sum.visits,
// dimensions.date/siteTag, siteTag_in, date_geq/date_leq) follow Cloudflare's
// GraphQL conventions; they are verified live only by the owner pilot.

export const STALE_MS = 30 * 60_000;
export const MANUAL_MS = 60_000;
const DAY_MS = 86_400_000;

export function lastSevenDays(nowMs = Date.now()) {
 const days = [];
 for (let i = 6; i >= 0; i--) days.push(new Date(nowMs - i * DAY_MS).toISOString().slice(0, 10));
 return days;
}

const literal = (s) => JSON.stringify(String(s));

export function visitsQuery(account, tags, since, until) {
 if (!/^[a-fA-F0-9]{32}$/.test(account)) throw new RemoteError("Invalid account.", 400);
 if (!tags.every((t) => /^[A-Za-z0-9_-]{1,64}$/.test(t))) throw new RemoteError("Invalid Web Analytics site.", 400);
 if (![since, until].every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) throw new RemoteError("Invalid date.", 400);
 return `query SitesVisits { viewer { accounts(filter: { accountTag: ${literal(account)} }) { rumPageloadEventsAdaptiveGroups(limit: 5000, filter: { siteTag_in: [${tags.map(literal).join(", ")}], date_geq: ${literal(since)}, date_leq: ${literal(until)} }, orderBy: [date_ASC]) { count sum { visits } dimensions { date siteTag } } } } }`;
}

export function probeQuery(account, day) {
 if (!/^[a-fA-F0-9]{32}$/.test(account) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RemoteError("Invalid account.", 400);
 return `query SitesVisitsCheck { viewer { accounts(filter: { accountTag: ${literal(account)} }) { rumPageloadEventsAdaptiveGroups(limit: 1, filter: { date_geq: ${literal(day)}, date_leq: ${literal(day)} }) { count } } } }`;
}

// Rows → {tag: [{date, visits, pageViews}] × 7}, zero-filled.
export function aggregate(data, tags, days) {
 const groups = data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups;
 if (!Array.isArray(groups)) throw new RemoteError("Cloudflare returned an unreadable visits answer.");
 const out = Object.fromEntries(tags.map((t) => [t, Object.fromEntries(days.map((d) => [d, { date: d, visits: 0, pageViews: 0 }]))]));
 for (const g of groups) {
  const tag = g?.dimensions?.siteTag;
  const date = g?.dimensions?.date;
  const cell = out[tag]?.[date];
  if (!cell) continue;
  const views = Number(g.count);
  const visits = Number(g.sum?.visits);
  cell.pageViews += Number.isFinite(views) && views > 0 ? Math.round(views) : 0;
  cell.visits += Number.isFinite(visits) && visits > 0 ? Math.round(visits) : 0;
 }
 return Object.fromEntries(Object.entries(out).map(([t, byDay]) => [t, days.map((d) => byDay[d])]));
}

export class PublicationVisits {
 constructor({ db }) {
  this.db = db;
  this.status = null; // { status: "ready"|"permission"|"unavailable"|"error", checkedAt, fingerprint }
  this.lastQueryAt = 0;
  this.running = null;
 }

 sites(account) {
  return this.db
   .prepare("SELECT id,analytics_tag FROM publications WHERE account_id=? AND status='published' AND analytics_tag IS NOT NULL")
   .all(account)
   .filter((p) => /^[A-Za-z0-9_-]{1,64}$/.test(p.analytics_tag));
 }

 stale(account, fingerprint, nowMs = Date.now()) {
  const sites = this.sites(account);
  if (!sites.length) return false;
  if (this.status?.fingerprint !== fingerprint) return true;
  if (this.status.status !== "ready") return nowMs - Date.parse(this.status.checkedAt) >= STALE_MS;
  const rows = new Map(this.db.prepare("SELECT publication_id,site_tag,fetched_at FROM visits WHERE account_id=?").all(account).map((r) => [r.publication_id, r]));
  return sites.some((s) => {
   const r = rows.get(s.id);
   return !r || r.site_tag !== s.analytics_tag || nowMs - Date.parse(r.fetched_at) >= STALE_MS;
  });
 }

 // One query for every site of the account. Never throws: the outcome is the
 // status Sites shows, and cached numbers stay until a newer answer.
 async refresh(cf, account, fingerprint, { nowMs = Date.now() } = {}) {
  if (this.running) return this.running;
  // A manual Refresh and the background round share one floor: one query a minute.
  if (nowMs - this.lastQueryAt < MANUAL_MS) return this.status;
  if (typeof cf?.graphql !== "function") return this.status;
  const sites = this.sites(account);
  if (!sites.length) return this.status;
  this.lastQueryAt = nowMs;
  this.running = (async () => {
   const days = lastSevenDays(nowMs);
   const tags = [...new Set(sites.map((s) => s.analytics_tag))];
   const checkedAt = new Date(nowMs).toISOString();
   try {
    const series = aggregate(await cf.graphql(visitsQuery(account, tags, days[0], days[6])), tags, days);
    const put = this.db.prepare(
     "INSERT INTO visits(publication_id,account_id,site_tag,days,fetched_at) VALUES(?,?,?,?,?) ON CONFLICT(publication_id) DO UPDATE SET account_id=excluded.account_id,site_tag=excluded.site_tag,days=excluded.days,fetched_at=excluded.fetched_at",
    );
    for (const s of sites) put.run(s.id, account, s.analytics_tag, JSON.stringify(series[s.analytics_tag]), checkedAt);
    this.status = { status: "ready", checkedAt, fingerprint };
   } catch (e) {
    const status = e instanceof RemoteError && e.status === 403 ? "permission" : e instanceof RemoteError && e.status === 409 ? "unavailable" : "error";
    this.status = { status, checkedAt, fingerprint };
   } finally {
    this.running = null;
   }
   return this.status;
  })();
  return this.running;
 }

 // Settings check and Check connection: a one-row query says whether the
 // token can read visits. It never blocks saving the token.
 async probe(cf, account, fingerprint, nowMs = Date.now()) {
  if (typeof cf?.graphql !== "function") return "unknown";
  const checkedAt = new Date(nowMs).toISOString();
  try {
   await cf.graphql(probeQuery(account, checkedAt.slice(0, 10)));
   if (this.status?.status !== "ready" || this.status.fingerprint !== fingerprint) this.status = { status: "ready", checkedAt, fingerprint, probed: true };
   return "ready";
  } catch (e) {
   if (e instanceof RemoteError && e.status === 403) {
    this.status = { status: "permission", checkedAt, fingerprint };
    return "permission";
   }
   return "unknown";
  }
 }

 summary(fingerprint) {
  const s = this.status?.fingerprint === fingerprint ? this.status : null;
  const messages = {
   permission: "Visits need Account Analytics: Read on the Cloudflare API token. Publishing is not affected.",
   unavailable: "Cloudflare does not offer these visit counts for this account.",
   error: "Visits could not be loaded just now; they refresh on their own.",
  };
  return s ? { status: s.status, checkedAt: s.checkedAt, message: messages[s.status] || "" } : { status: "unchecked", checkedAt: null, message: "" };
 }

 forPublication(p) {
  if (!p.analytics_tag) return null;
  const r = this.db.prepare("SELECT site_tag,days,fetched_at FROM visits WHERE publication_id=?").get(p.id);
  if (!r || r.site_tag !== p.analytics_tag) return { days: [], visits: null, pageViews: null, fetchedAt: null };
  let days = [];
  try {
   days = JSON.parse(r.days);
  } catch {}
  if (!Array.isArray(days)) days = [];
  return {
   days,
   visits: days.reduce((n, d) => n + (Number(d.visits) || 0), 0),
   pageViews: days.reduce((n, d) => n + (Number(d.pageViews) || 0), 0),
   fetchedAt: r.fetched_at,
  };
 }

 forget(p) {
  this.db.prepare("DELETE FROM visits WHERE publication_id=?").run(p.id);
 }
}
