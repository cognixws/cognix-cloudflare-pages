// 0.6.0 (v2 F2): custom domains (D6), cached 7-day visits (D5), Keep up to
// date (D4) and per-version links (D10), against the loopback Cloudflare fake.
// No real account, no real token, no network beyond 127.0.0.1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { Cloudflare, RemoteError } from "../cloudflare.mjs";
import { PagesService } from "../service.mjs";
import { normalizeHostname } from "../domains.mjs";
import { aggregate, lastSevenDays, visitsQuery } from "../visits.mjs";
import { startFakeCloudflare } from "./fake-cloudflare.mjs";
import { ACCT_A, ACCT_B, CTX, applyMigrations, createFakeHost, makeBundle } from "./v2-host.mjs";

const TOKEN = "cfut_fake_valid_token";

async function setup(t, { transport } = {}) {
 const fake = await startFakeCloudflare();
 t.after(() => fake.close());
 const h = createFakeHost();
 const db = applyMigrations(new DatabaseSync(":memory:"));
 t.after(() => db.close());
 const svc = new PagesService({
  db,
  host: h.host,
  remote: (acct, tok) => new Cloudflare(acct, tok, transport || fetch, fake.url),
  emit: (name, data) => h.host("/events", 1 << 20, { name, data }),
 });
 t.after(() => {
  svc.closing = true;
 });
 const control = (body) => fetch(fake.url + "/__fake/control", { method: "POST", body: JSON.stringify(body) });
 await svc.checkConnection();
 const settle = async () => {
  for (let i = 0; i < 3000 && (svc.running.size || svc.syncing); i++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(svc.running.size, 0, "operations settled");
 };
 const confirm = async (op) => {
  await svc.confirm(op.id, op.revision);
  await settle();
  return svc.op(op.id);
 };
 const publish = async (artifactId, version, extra = {}) => confirm(await svc.prepare({ artifactId, version, ...extra }));
 const site = async (artifactId) => (await svc.state()).publications.find((p) => p.artifact_id === artifactId);
 const project = (name) => fake.acct(ACCT_A).projects.get(name);
 const requests = (re, method) => fake.state.requests.filter((r) => re.test(r.path) && (!method || r.method === method));
 const addVersion = (id, n, extra = {}) => {
  const entry = h.artifacts.get(id);
  entry.meta.liveVersion = n;
  entry.meta.versions = [{ n, kind: entry.meta.kind, files: [{ path: "index.html" }], ...extra }, ...entry.meta.versions];
  if (!extra.capabilities) entry.bundles[n] = makeBundle(id, n, [{ path: "index.html", content: `<!doctype html><h1>${id} v${n}</h1>` }]);
 };
 return { fake, h, db, svc, control, settle, confirm, publish, site, project, requests, addVersion };
}

// A transport that delivers one matching request to the fake and then loses
// its answer, as a dropped connection would.
function losing(match, armed = true) {
 const transport = async (url, init) => {
  const res = await fetch(url, init);
  if (armed && match(String(url), init || {})) {
   armed = false;
   throw new TypeError("connection reset");
  }
  return res;
 };
 transport.arm = () => {
  armed = true;
 };
 return transport;
}

// ---------------------------------------------------------------- D6 domains

test("D6 zone in this account: the domain is added in Pages first, then its CNAME; Check now reads it active", async (t) => {
 const x = await setup(t);
 await x.control({ addZone: { accountId: ACCT_A, name: "example.com" } });
 assert.equal((await x.publish("q3-report", 2)).status, "published");
 const pub = await x.site("q3-report");

 const op = await x.svc.prepare({ action: "domain-add", publicationId: pub.id, hostname: " Docs.Example.com. " });
 assert.equal(op.confirmation.title, "Add docs.example.com to this site?");
 assert.match(op.confirmation.message, /creates the CNAME record docs\.example\.com → q3-revenue-report\.pages\.dev in the example\.com zone/);
 assert.equal(op.confirmation.danger, false);
 assert.equal((await x.confirm(op)).status, "published");

 const order = x.fake.state.requests.map((r) => `${r.method} ${r.path}`);
 const addAt = order.findIndex((r) => r.endsWith("/pages/projects/q3-revenue-report/domains") && r.startsWith("POST"));
 const dnsAt = order.findIndex((r) => r.startsWith("POST") && /\/dns_records$/.test(r));
 assert.ok(addAt >= 0 && dnsAt > addAt, "Pages domain before the CNAME (a CNAME first answers 522)");
 const rec = [...x.fake.state.zones.values()][0].records;
 assert.equal(rec.size, 1);
 const record = [...rec.values()][0];
 assert.deepEqual([record.type, record.name, record.content, record.proxied], ["CNAME", "docs.example.com", "q3-revenue-report.pages.dev", true]);

 let d = (await x.site("q3-report")).domains[0];
 assert.equal(d.hostname, "docs.example.com");
 assert.equal(d.dns, "auto");
 assert.equal(d.ownedRecord, true);
 assert.equal(d.zone, "example.com");
 const checked = await x.svc.checkDomain(pub.id, "docs.example.com");
 assert.equal(checked.state, "active");
 assert.equal(checked.url, "https://docs.example.com/");
 d = (await x.site("q3-report")).domains[0];
 assert.equal(d.state, "active");
 assert.ok(d.verifiedAt);
});

test("D6 external DNS: the exact record to add is shown, DNS is never touched, the background round sees it go active", async (t) => {
 const x = await setup(t);
 await x.publish("q3-report", 2);
 const pub = await x.site("q3-report");
 const op = await x.svc.prepare({ action: "domain-add", publicationId: pub.id, hostname: "report.partner.io" });
 assert.match(op.confirmation.message, /Then add this record at the DNS provider of report\.partner\.io: CNAME report\.partner\.io → q3-revenue-report\.pages\.dev\./);
 await x.confirm(op);
 assert.equal(x.requests(/dns_records/).length, 0);
 const d = (await x.site("q3-report")).domains[0];
 assert.deepEqual(d.record, { type: "CNAME", name: "report.partner.io", content: "q3-revenue-report.pages.dev" });
 assert.equal(d.dns, "manual");
 assert.equal(d.state, "waiting");

 await x.control({ domainStatus: { accountId: ACCT_A, project: "q3-revenue-report", name: "report.partner.io", status: "active" } });
 await x.svc.background({ force: true });
 assert.equal((await x.site("q3-report")).domains[0].state, "active");
});

test("D6 without DNS permission the record is shown instead: zone not readable, or DNS not writable", async (t) => {
 const x = await setup(t);
 await x.control({ addZone: { accountId: ACCT_A, name: "example.com" } });
 await x.publish("q3-report", 2);
 const pub = await x.site("q3-report");

 await x.control({ denyZones: true });
 const op1 = await x.svc.prepare({ action: "domain-add", publicationId: pub.id, hostname: "a.example.com" });
 assert.match(op1.confirmation.message, /The token cannot edit this name's DNS, so Sites shows the record instead of creating it\./);
 await x.confirm(op1);
 await x.control({ denyZones: false, denyDnsWrite: true });
 const op2 = await x.svc.prepare({ action: "domain-add", publicationId: pub.id, hostname: "b.example.com" });
 assert.match(op2.confirmation.message, /creates the CNAME record .* when the token may edit its DNS; otherwise Sites shows the record to add\./);
 assert.equal((await x.confirm(op2)).status, "published");
 const domains = (await x.site("q3-report")).domains;
 assert.deepEqual(domains.map((d) => [d.hostname, d.dns, d.ownedRecord]), [["a.example.com", "manual", false], ["b.example.com", "manual", false]]);
 assert.equal([...x.fake.state.zones.values()][0].records.size, 0);
});

test("D6 refusals: whole domains, reserved names, foreign records, taken names, restricted sites, address change", async (t) => {
 const x = await setup(t);
 await x.control({ addZone: { accountId: ACCT_A, name: "example.com" } });
 await x.control({ addZone: { accountId: ACCT_A, name: "shop.example.org" } });
 await x.control({ addRecord: { zone: "example.com", record: { type: "A", name: "busy.example.com", content: "192.0.2.1" } } });
 await x.publish("q3-report", 2);
 await x.publish("checkout-flow", 1);
 const pub = await x.site("q3-report");
 const other = await x.site("checkout-flow");
 const refuse = (hostname, re, id = pub.id) => assert.rejects(x.svc.prepare({ action: "domain-add", publicationId: id, hostname }), re);

 assert.throws(() => normalizeHostname("example.com"), /Use a subdomain such as www\.example\.com/);
 await refuse("example.com", /Use a subdomain/);
 await refuse("evil.pages.dev", /Cloudflare's own and reserved names/);
 await refuse("bad_name.example.com", /Enter a domain/);
 await refuse("shop.example.org", /is a whole domain \(its own zone\)/);
 await refuse("busy.example.com", /already has a A record in example\.com\. Change or delete it in Cloudflare first/);

 await x.confirm(await x.svc.prepare({ action: "domain-add", publicationId: pub.id, hostname: "docs.example.com" }));
 await refuse("docs.example.com", /already on this site/);
 await refuse("docs.example.com", /already on another of your sites/, other.id);

 // Custom domains belong to public sites; an address change would strand them.
 await assert.rejects(x.svc.prepare({ action: "rename", publicationId: pub.id, projectName: "q3-new" }), /Remove the custom domains first: they point at the current address/);
 await assert.rejects(
  x.svc.prepare({ action: "access", publicationId: pub.id, access: { mode: "restricted", emails: ["a@example.com"] } }),
  /Remove the custom domains first: a restricted site keeps to its \.pages\.dev address/,
 );
 await x.publish("private-notes", 2, { access: { mode: "restricted", emails: ["reader@example.com"] } });
 const restricted = await x.site("private-notes");
 assert.equal(restricted.access_mode, "restricted");
 await refuse("notes.example.com", /This site is restricted, so it keeps its \.pages\.dev address/, restricted.id);
});

test("D6 removing a domain deletes Sites' CNAME before the domain; a record changed by someone else is left alone", async (t) => {
 const x = await setup(t);
 await x.control({ addZone: { accountId: ACCT_A, name: "example.com" } });
 await x.publish("q3-report", 2);
 const pub = await x.site("q3-report");
 for (const hostname of ["docs.example.com", "kept.example.com"]) await x.confirm(await x.svc.prepare({ action: "domain-add", publicationId: pub.id, hostname }));
 const zone = [...x.fake.state.zones.values()][0];
 assert.equal(zone.records.size, 2);

 const op = await x.svc.prepare({ action: "domain-remove", publicationId: pub.id, hostname: "docs.example.com" });
 assert.equal(op.confirmation.danger, true);
 assert.match(op.confirmation.message, /Sites deletes the CNAME record docs\.example\.com → q3-revenue-report\.pages\.dev it created \(only if it is unchanged\), then removes the domain/);
 const mark = x.fake.state.requests.length;
 assert.equal((await x.confirm(op)).status, "removed");
 const after = x.fake.state.requests.slice(mark).map((r) => `${r.method} ${r.path}`);
 const dnsDel = after.findIndex((r) => r.startsWith("DELETE") && r.includes("/dns_records/"));
 const domDel = after.findIndex((r) => r.startsWith("DELETE") && r.endsWith("/domains/docs.example.com"));
 assert.ok(dnsDel >= 0 && domDel > dnsDel, "CNAME first, then the domain (Cloudflare's order)");
 assert.equal(zone.records.size, 1);
 assert.ok(!x.project("q3-revenue-report").domains.includes("docs.example.com"));

 // Someone repoints the other record: removal leaves it and says so.
 const kept = [...zone.records.values()][0];
 kept.content = "elsewhere.example.net";
 const op2 = await x.confirm(await x.svc.prepare({ action: "domain-remove", publicationId: pub.id, hostname: "kept.example.com" }));
 assert.equal(op2.status, "removed");
 assert.equal(zone.records.size, 1);
 assert.match(JSON.parse(op2.warnings)[0].message, /changed outside Sites, so it was left in place/);
 assert.deepEqual((await x.site("q3-report")).domains, []);
});

test("D6 removing the site deletes Sites' CNAME records before the project and names the records the person must delete", async (t) => {
 const x = await setup(t);
 await x.control({ addZone: { accountId: ACCT_A, name: "example.com" } });
 await x.publish("q3-report", 2);
 const pub = await x.site("q3-report");
 for (const hostname of ["docs.example.com", "report.partner.io"]) await x.confirm(await x.svc.prepare({ action: "domain-add", publicationId: pub.id, hostname }));
 const op = await x.svc.prepare({ action: "remove", publicationId: pub.id });
 assert.match(op.confirmation.message, /Deletes the CNAME record Sites created for docs\.example\.com first\./);
 assert.match(op.confirmation.message, /Then delete the CNAME record for report\.partner\.io at its DNS provider/);
 const mark = x.fake.state.requests.length;
 assert.equal((await x.confirm(op)).status, "removed");
 const after = x.fake.state.requests.slice(mark).map((r) => `${r.method} ${r.path}`);
 const dnsDel = after.findIndex((r) => r.startsWith("DELETE") && r.includes("/dns_records/"));
 const projDel = after.findIndex((r) => r === `DELETE /client/v4/accounts/${ACCT_A}/pages/projects/q3-revenue-report`);
 assert.ok(dnsDel >= 0 && projDel > dnsDel, "records first, so no name points at a deleted project");
 assert.equal([...x.fake.state.zones.values()][0].records.size, 0);
 assert.equal(x.db.prepare("SELECT count(*) n FROM publication_domains").get().n, 0);
});

test("D6 a lost answer on the domain add is settled by reading the name back: one domain, one record", async (t) => {
 const transport = losing((url, init) => init.method === "POST" && url.endsWith("/pages/projects/q3-revenue-report/domains"));
 const x = await setup(t, { transport });
 await x.control({ addZone: { accountId: ACCT_A, name: "example.com" } });
 await x.publish("q3-report", 2);
 const pub = await x.site("q3-report");
 const op = await x.confirm(await x.svc.prepare({ action: "domain-add", publicationId: pub.id, hostname: "docs.example.com" }));
 assert.equal(op.status, "unknown");
 assert.equal((await x.site("q3-report")).domains[0].state, "adding");
 x.svc.reconcile(op.id);
 await x.settle();
 assert.equal(x.svc.op(op.id).status, "published");
 assert.equal(x.requests(/\/pages\/projects\/q3-revenue-report\/domains$/, "POST").length, 1);
 assert.equal([...x.fake.state.zones.values()][0].records.size, 1);
 assert.equal((await x.site("q3-report")).domains[0].dns, "auto");
});

// ---------------------------------------------------------------- D5 visits

test("D5 visits: one GraphQL query for every site, cached in SQLite, seven zero-filled days, Visits and Page views", async (t) => {
 const x = await setup(t);
 await x.publish("q3-report", 2, { analytics: true });
 await x.publish("checkout-flow", 1, { analytics: true });
 const [a, b] = [await x.site("q3-report"), await x.site("checkout-flow")];
 const tagA = x.svc.pub(a.id).analytics_tag;
 const tagB = x.svc.pub(b.id).analytics_tag;
 const days = lastSevenDays();
 await x.control({
  rumEvents: [
   { siteTag: tagA, date: days[6], visits: 5, pageViews: 9 },
   { siteTag: tagA, date: days[5], visits: 2, pageViews: 3 },
   { siteTag: tagB, date: days[0], visits: 1, pageViews: 1 },
   { siteTag: tagA, date: "2001-01-01", visits: 99, pageViews: 99 },
  ],
 });
 const before = x.fake.state.graphqlQueries.length;
 const summary = await x.svc.refreshVisits();
 assert.equal(summary.status, "ready");
 assert.equal(x.fake.state.graphqlQueries.length, before + 1, "one query for both sites");
 const q = x.fake.state.graphqlQueries.at(-1);
 assert.match(q, /rumPageloadEventsAdaptiveGroups/);
 assert.ok(q.includes(`"${tagA}"`) && q.includes(`"${tagB}"`));
 const va = (await x.site("q3-report")).visits;
 assert.equal(va.visits, 7);
 assert.equal(va.pageViews, 12);
 assert.equal(va.days.length, 7);
 assert.deepEqual(va.days.at(-1), { date: days[6], visits: 5, pageViews: 9 });
 assert.equal((await x.site("checkout-flow")).visits.visits, 1);
 assert.equal(x.db.prepare("SELECT count(*) n FROM visits").get().n, 2);

 // Cached: no second query within 30 minutes, nor a manual one within a minute.
 await x.svc.refreshVisits();
 await x.svc.refreshVisits({ manual: true });
 assert.equal(x.fake.state.graphqlQueries.length, before + 1);
 assert.equal((await x.svc.state()).visits.status, "ready");
});

test("D5 a token without Account Analytics: Read: Sites says so, the page and publishing never fail", async (t) => {
 const x = await setup(t);
 await x.control({ denyAnalyticsQuery: true });
 const saved = await x.svc.checkSettings({ values: { account_id: ACCT_A }, secrets: { api_token: TOKEN } });
 assert.equal(saved.status, 200, "saving the token is never blocked");
 const conn = await x.svc.checkConnection();
 assert.equal(conn.status, "ready");
 assert.equal(conn.visits, "permission");
 assert.match(conn.message, /Visits need Account Analytics: Read on the token\./);
 assert.equal((await x.publish("q3-report", 2, { analytics: true })).status, "published");
 x.svc.visits.lastQueryAt = 0;
 const summary = await x.svc.refreshVisits({ manual: true });
 assert.equal(summary.status, "permission");
 const st = await x.svc.state();
 assert.equal(st.visits.status, "permission");
 assert.match(st.visits.message, /Visits need Account Analytics: Read on the Cloudflare API token\. Publishing is not affected\./);
 assert.equal(st.publications[0].status, "published");
});

test("D5 the query is built from validated values only, and answers are zero-filled per site", () => {
 assert.throws(() => visitsQuery(ACCT_A, ['x"]) { evil }'], "2026-01-01", "2026-01-07"), /Invalid Web Analytics site/);
 assert.throws(() => visitsQuery("nope", ["t1"], "2026-01-01", "2026-01-07"), /Invalid account/);
 const days = ["2026-01-01", "2026-01-02"];
 const out = aggregate({ viewer: { accounts: [{ rumPageloadEventsAdaptiveGroups: [{ count: 4, sum: { visits: 2 }, dimensions: { date: "2026-01-02", siteTag: "t1" } }, { count: -3, sum: { visits: "x" }, dimensions: { date: "2026-01-01", siteTag: "t1" } }] }] } }, ["t1", "t2"], days);
 assert.deepEqual(out.t1, [{ date: "2026-01-01", visits: 0, pageViews: 0 }, { date: "2026-01-02", visits: 2, pageViews: 4 }]);
 assert.deepEqual(out.t2.map((d) => d.visits), [0, 0]);
 assert.throws(() => aggregate({ viewer: {} }, ["t1"], days), /unreadable visits answer/);
});

// ---------------------------------------------------------------- D10 links

test("D10 each version keeps its own link; deleting one that is not live is confirmed, and Restore then re-uploads it", async (t) => {
 const x = await setup(t);
 await x.publish("q3-report", 1);
 await x.publish("q3-report", 2);
 const pub = await x.site("q3-report");
 const v1 = pub.history.find((d) => d.version === 1);
 const live = pub.history.find((d) => d.version === 2);
 assert.match(v1.url, /^https:\/\/dep_\d+\.q3-revenue-report\.pages\.dev\/$/);
 await assert.rejects(x.svc.prepare({ action: "delete-link", publicationId: pub.id, deployment: live.id }), /The live version's link cannot be deleted/);

 const op = await x.svc.prepare({ action: "delete-link", publicationId: pub.id, deployment: v1.id });
 assert.equal(op.confirmation.title, "Delete the link of version 1?");
 assert.equal(op.confirmation.danger, true);
 assert.equal(op.confirmation.message, `${v1.url} stops working. q3-revenue-report.pages.dev keeps showing version 2, and version 1 can still be restored from COGNIX[WS].`);
 assert.equal((await x.confirm(op)).status, "removed");
 assert.ok(!x.project("q3-revenue-report").deployments.some((d) => d.id === v1.id));
 const row = (await x.site("q3-report")).history.find((d) => d.id === v1.id);
 assert.equal(row.linkDeleted, true);
 assert.equal(row.pruned, true);
 await assert.rejects(x.svc.prepare({ action: "delete-link", publicationId: pub.id, deployment: v1.id }), /no longer exists/);

 const restore = await x.svc.prepare({ action: "rollback", publicationId: pub.id, version: 1 });
 assert.match(restore.confirmation.message, /re-uploaded from your local COGNIX\[WS\] artifact copy/);
 assert.equal((await x.confirm(restore)).status, "published");
 assert.equal((await x.site("q3-report")).version, 1);
});

// ------------------------------------------------- D4 Keep up to date table
// Rows: Keep up to date × synced computers × artifact change × token
// permissions (docs/acceptance.md, "0.6.0 Keep up to date decision table").

test("D4 row 1: off by default — a new version waits as Update ready, nothing is published", async (t) => {
 const x = await setup(t);
 await x.publish("q3-report", 2);
 assert.equal((await x.site("q3-report")).keepUpdated, false);
 x.addVersion("q3-report", 3);
 const deploys = x.requests(/\/deployments$/, "POST").length;
 await x.svc.syncRound();
 await x.settle();
 assert.equal(x.requests(/\/deployments$/, "POST").length, deploys);
 assert.equal((await x.site("q3-report")).siteStatus, "update");
});

test("D4 rows 2 and 17: turning it on is confirmed and publishes a waiting version at once; later versions follow quietly, keeping access and analytics", async (t) => {
 const x = await setup(t);
 await x.publish("q3-report", 2, { analytics: true });
 x.addVersion("q3-report", 3);
 const pub = await x.site("q3-report");
 const op = await x.svc.prepare({ action: "keep", publicationId: pub.id });
 assert.equal(op.confirmation.title, "Keep “Q3 Revenue Report” up to date?");
 assert.match(op.confirmation.message, /Version 3 is newer than the live version 2; it is published right after you confirm\./);
 assert.match(op.confirmation.message, /Restoring or publishing an older version turns this off\./);
 await x.confirm(op);
 await x.svc.syncRound();
 await x.settle();
 let s = await x.site("q3-report");
 assert.equal(s.keepUpdated, true);
 assert.equal(s.version, 3);
 assert.equal(s.operations.find((o) => o.action === "publish" && o.version === 3).actor, "auto");

 x.addVersion("q3-report", 4);
 await x.svc.syncRound();
 await x.settle();
 s = await x.site("q3-report");
 assert.equal(s.version, 4);
 assert.equal(s.access_mode, "public");
 assert.ok(s.analytics, "analytics kept");
 assert.equal(x.h.inboxNotes.length, 0, "no Inbox note when it works");
 assert.equal((await x.svc.prepare({ action: "keep", publicationId: pub.id })).unchanged, true);

 // Row 3: no change, no publish.
 const deploys = x.requests(/\/deployments$/, "POST").length;
 await x.svc.syncRound();
 await x.settle();
 assert.equal(x.requests(/\/deployments$/, "POST").length, deploys);

 // Off needs no confirmation.
 assert.deepEqual(await x.svc.setKeep(pub.id, false), { keepUpdated: false });
 await assert.rejects(x.svc.setKeep(pub.id, true), /through its confirmation/);
});

test("D4 row 5: a computer whose records are stale (Cloudflare shows a version it did not publish) turns it off instead of publishing", async (t) => {
 const x = await setup(t);
 await x.publish("q3-report", 2);
 const pub = await x.site("q3-report");
 await x.confirm(await x.svc.prepare({ action: "keep", publicationId: pub.id }));
 await x.settle();
 // Another computer (or the dashboard) publishes to the same project.
 const elsewhere = new Cloudflare(ACCT_A, TOKEN, fetch, x.fake.url);
 const form = await elsewhere.deploy("q3-revenue-report", makeBundle("q3-report", 2, [{ path: "index.html", content: "<h1>from another computer</h1>" }]), "picode:other-computer:x");
 await elsewhere.createDeployment("q3-revenue-report", form);
 x.addVersion("q3-report", 3);
 const deploys = x.requests(/\/deployments$/, "POST").length;
 await x.svc.syncRound();
 await x.settle();
 assert.equal(x.requests(/\/deployments$/, "POST").length, deploys, "never publishes over another computer's work");
 const s = await x.site("q3-report");
 assert.equal(s.keepUpdated, false);
 assert.match(s.syncNote, /Cloudflare shows a version this computer did not publish/);
 assert.equal(x.h.inboxNotes.length, 1);
 assert.match(x.h.inboxNotes[0].title, /Keep up to date turned off for Q3 Revenue Report/);
});

test("D4 row 6: a version that cannot be a static site is not published, one note per version; a newer good version follows", async (t) => {
 const x = await setup(t);
 await x.publish("q3-report", 2);
 const pub = await x.site("q3-report");
 await x.confirm(await x.svc.prepare({ action: "keep", publicationId: pub.id }));
 await x.settle();
 x.addVersion("q3-report", 3, { capabilities: ["state"] });
 await x.svc.syncRound();
 await x.svc.syncRound();
 await x.settle();
 let s = await x.site("q3-report");
 assert.equal(s.version, 2);
 assert.equal(s.syncFailedVersion, 3);
 assert.match(s.syncNote, /Version 3 was not published automatically\. Version 3 declares workspace capabilities/);
 assert.equal(x.h.inboxNotes.length, 1, "one note, not one a minute");
 assert.match(x.h.inboxNotes[0].title, /Keep up to date could not publish version 3 of Q3 Revenue Report/);
 x.addVersion("q3-report", 4);
 await x.svc.syncRound();
 await x.settle();
 s = await x.site("q3-report");
 assert.equal(s.version, 4);
 assert.equal(s.syncNote, null);
 assert.equal(s.syncFailedVersion, null);
});

test("D4 row 7: a refused token pauses it with one note; it resumes when the token works again", async (t) => {
 const x = await setup(t);
 await x.publish("q3-report", 2);
 const pub = await x.site("q3-report");
 await x.confirm(await x.svc.prepare({ action: "keep", publicationId: pub.id }));
 await x.settle();
 await x.control({ expireToken: TOKEN });
 assert.equal((await x.svc.checkConnection()).status, "error");
 x.addVersion("q3-report", 3);
 const deploys = x.requests(/\/deployments$/, "POST").length;
 await x.svc.syncRound();
 await x.svc.syncRound();
 await x.settle();
 assert.equal(x.requests(/\/deployments$/, "POST").length, deploys);
 let s = await x.site("q3-report");
 assert.equal(s.version, 2);
 assert.equal(s.keepUpdated, true);
 assert.match(s.syncNote, /Cloudflare refused the API token/);
 assert.equal(x.h.inboxNotes.length, 1);
 await x.control({ restoreToken: TOKEN });
 assert.equal((await x.svc.checkConnection()).status, "ready");
 await x.svc.syncRound();
 await x.settle();
 s = await x.site("q3-report");
 assert.equal(s.version, 3);
 assert.equal(s.syncNote, null);
});

test("D4 row 8: without Account Analytics: Read it still publishes; only visits say what is missing", async (t) => {
 const x = await setup(t);
 await x.control({ denyAnalyticsQuery: true });
 await x.svc.checkConnection();
 await x.publish("q3-report", 2, { analytics: true });
 const pub = await x.site("q3-report");
 await x.confirm(await x.svc.prepare({ action: "keep", publicationId: pub.id }));
 x.addVersion("q3-report", 3);
 await x.svc.syncRound();
 await x.settle();
 assert.equal((await x.site("q3-report")).version, 3);
 x.svc.visits.lastQueryAt = 0;
 assert.equal((await x.svc.refreshVisits({ manual: true })).status, "permission");
});

test("D4 row 10: a restricted site waits while Access is not ready, with one note", async (t) => {
 const x = await setup(t);
 await x.svc.checkAccessSetup();
 await x.publish("private-notes", 1, { access: { mode: "restricted", emails: ["reader@example.com"] } });
 const pub = await x.site("private-notes");
 assert.equal(pub.access_mode, "restricted");
 await x.confirm(await x.svc.prepare({ action: "keep", publicationId: pub.id }));
 await x.settle();
 assert.equal((await x.site("private-notes")).version, 2, "version 2 was already waiting");
 x.h.settings.access_api_token = "";
 assert.equal((await x.svc.checkConnection()).status, "ready");
 x.addVersion("private-notes", 3);
 await x.svc.syncRound();
 await x.svc.syncRound();
 await x.settle();
 const s = await x.site("private-notes");
 assert.equal(s.version, 2);
 assert.match(s.syncNote, /Version 3 waits: restricted access needs setup/);
 assert.equal(x.h.inboxNotes.length, 1);
});

test("D4 row 10b: just after a restart, before Access is checked, a restricted site waits without a note", async (t) => {
 const x = await setup(t);
 await x.svc.checkAccessSetup();
 await x.publish("private-notes", 2, { access: { mode: "restricted", emails: ["reader@example.com"] } });
 const pub = await x.site("private-notes");
 await x.confirm(await x.svc.prepare({ action: "keep", publicationId: pub.id }));
 await x.settle();
 x.svc.accessSetupCheck = null; // a fresh process: the startup check has not answered yet
 x.addVersion("private-notes", 3);
 await x.svc.syncRound();
 await x.settle();
 const s = await x.site("private-notes");
 assert.equal(s.version, 2);
 assert.equal(s.syncNote, null);
 assert.equal(x.h.inboxNotes.length, 0);
 await x.svc.checkAccessSetup();
 await x.svc.syncRound();
 await x.settle();
 assert.equal((await x.site("private-notes")).version, 3);
});

test("D4 row 11: an operation in progress on the site makes the round wait", async (t) => {
 const x = await setup(t);
 await x.publish("q3-report", 2);
 const pub = await x.site("q3-report");
 await x.confirm(await x.svc.prepare({ action: "keep", publicationId: pub.id }));
 await x.settle();
 const pending = await x.svc.prepare({ action: "analytics", publicationId: pub.id, analytics: true });
 x.addVersion("q3-report", 3);
 await x.svc.syncRound();
 await x.settle();
 assert.equal((await x.site("q3-report")).version, 2);
 x.svc.cancel(pending.id);
 await x.svc.syncRound();
 await x.settle();
 assert.equal((await x.site("q3-report")).version, 3);
});

test("D4 row 12: Cloudflare refuses the automatic publish — the site keeps its version, one note, Try again retries", async (t) => {
 const x = await setup(t);
 await x.publish("q3-report", 2);
 const pub = await x.site("q3-report");
 await x.confirm(await x.svc.prepare({ action: "keep", publicationId: pub.id }));
 await x.settle();
 await x.control({ failDeployStatus: 400 });
 x.addVersion("q3-report", 3);
 await x.svc.syncRound();
 await x.settle();
 await x.svc.syncRound();
 await x.settle();
 let s = await x.site("q3-report");
 assert.equal(s.version, 2);
 assert.equal(s.syncFailedVersion, 3);
 assert.equal(x.h.inboxNotes.length, 1);
 assert.match(x.h.inboxNotes[0].body, /The site keeps version 2\./);
 assert.equal(x.requests(/\/deployments$/, "POST").length, 2, "v2 once, v3 once: not retried on its own");
 await x.control({ failDeployStatus: 0 });
 await x.svc.retrySync(pub.id);
 await x.settle();
 s = await x.site("q3-report");
 assert.equal(s.version, 3);
 assert.equal(s.syncFailedVersion, null);
});

test("D4 row 13: a person's restore of an older version turns it off (said in the confirmation); an agent's restore says so too", async (t) => {
 const x = await setup(t);
 await x.publish("q3-report", 1);
 await x.publish("q3-report", 2);
 const pub = await x.site("q3-report");
 await x.confirm(await x.svc.prepare({ action: "keep", publicationId: pub.id }));
 await x.settle();
 const op = await x.svc.prepare({ action: "rollback", publicationId: pub.id, version: 1 });
 assert.match(op.confirmation.message, /Keep up to date turns off, so the site stays on version 1\./);
 await x.confirm(op);
 let s = await x.site("q3-report");
 assert.equal(s.version, 1);
 assert.equal(s.keepUpdated, false);
 assert.match(s.syncNote, /Turned off when version 1 was restored/);
 await x.svc.syncRound();
 await x.settle();
 assert.equal((await x.site("q3-report")).version, 1, "the round never undoes the restore");

 await x.confirm(await x.svc.prepare({ action: "keep", publicationId: pub.id }));
 await x.settle();
 assert.equal((await x.site("q3-report")).version, 2);
 const res = await x.svc.runTool({ protocol: "picode-tools/1", capability: "pages", context: CTX, tool: "restore", arguments: { artifact: "q3-report", version: 1 } });
 assert.equal(res.isError, undefined);
 assert.match(res.content[0].text, /Keep up to date was turned off, so the site stays on this version\./);
 assert.equal(res.structuredContent.keepUpToDate, false);
 const status = await x.svc.runTool({ protocol: "picode-tools/1", capability: "pages", context: CTX, tool: "status", arguments: { artifact: "q3-report" } });
 assert.equal(status.structuredContent.keepUpToDate, false);
 // An agent publishing an older version turns it off too, and says so.
 await x.confirm(await x.svc.prepare({ action: "keep", publicationId: pub.id }));
 await x.settle();
 assert.equal((await x.site("q3-report")).version, 2);
 const older = await x.svc.runTool({ protocol: "picode-tools/1", capability: "pages", context: CTX, tool: "publish", arguments: { artifact: "q3-report", version: 1 } });
 assert.equal(older.isError, undefined, older.content[0].text);
 assert.match(older.content[0].text, /Keep up to date was turned off, so the site stays on this older version\./);
 assert.equal(older.structuredContent.keepUpToDate, false);
 const unknownTool = await x.svc.runTool({ protocol: "picode-tools/1", capability: "pages", context: CTX, tool: "keep", arguments: { artifact: "q3-report" } });
 assert.equal(unknownTool.isError, true, "agents cannot turn it on (D3)");
});

test("D4 rows 14 and 15: a removed site, or a site of another Cloudflare account, is never followed", async (t) => {
 const x = await setup(t);
 await x.publish("q3-report", 2);
 await x.publish("checkout-flow", 1);
 const a = await x.site("q3-report");
 const b = await x.site("checkout-flow");
 for (const p of [a, b]) await x.confirm(await x.svc.prepare({ action: "keep", publicationId: p.id }));
 await x.settle();
 await x.confirm(await x.svc.prepare({ action: "remove", publicationId: a.id }));
 assert.equal((await x.site("q3-report")).keepUpdated, false);

 x.h.settings.account_id = ACCT_B;
 x.h.settings.api_token = "cfut_fake_account_b";
 await x.svc.checkConnection();
 x.addVersion("checkout-flow", 2);
 x.addVersion("q3-report", 3);
 const deploys = x.requests(/\/deployments$/, "POST").length;
 await x.svc.syncRound();
 await x.settle();
 assert.equal(x.requests(/\/deployments$/, "POST").length, deploys);
 assert.equal((await x.site("checkout-flow")).version, 1);
});

test("D4 row 16: an uncertain automatic publish holds at Check result; the round never makes a second deployment", async (t) => {
 const transport = losing((url, init) => init.method === "POST" && /\/pages\/projects\/q3-revenue-report\/deployments$/.test(url), false);
 const x = await setup(t, { transport });
 await x.publish("q3-report", 2);
 const pub = await x.site("q3-report");
 await x.confirm(await x.svc.prepare({ action: "keep", publicationId: pub.id }));
 await x.settle();
 transport.arm();
 x.addVersion("q3-report", 3);
 await x.svc.syncRound();
 await x.settle();
 const s = await x.site("q3-report");
 const op = s.operations[0];
 assert.equal(op.status, "unknown");
 assert.equal(op.actor, "auto");
 assert.match(x.h.inboxNotes.at(-1).title, /Keep up to date could not confirm version 3/);
 await x.svc.syncRound();
 await x.settle();
 assert.equal(x.requests(/\/deployments$/, "POST").length, 2, "v2, then v3 once");
 x.svc.reconcile(op.id);
 await x.settle();
 assert.equal(x.svc.op(op.id).status, "published");
 assert.equal((await x.site("q3-report")).version, 3);
});

test("0.6.0 migration keeps 0.5.x rows: Keep up to date off, no domains, no visits", () => {
 const db = new DatabaseSync(":memory:");
 try {
  const files = ["001_publications.sql", "002_project_provenance.sql", "003_access.sql", "004_domains.sql", "005_analytics.sql", "006_v2_f1.sql"];
  for (const f of files) db.exec(readMigration(f));
  db.prepare("INSERT INTO publications(id,artifact_id,title,account_id,project,identity,status,version,created_at) VALUES('p','a','T',?, 'proj','id','published',2,'d')").run(ACCT_A);
  db.prepare("INSERT INTO deployments(id,publication_id,operation_id,version,digest,url,project,created_at) VALUES('d1','p','o',2,'x','https://d1.proj.pages.dev/','proj','d')").run();
  db.exec(readMigration("007_v2_f2.sql"));
  const p = db.prepare("SELECT keep_updated,sync_note,sync_failed_version FROM publications").get();
  assert.deepEqual({ ...p }, { keep_updated: 0, sync_note: null, sync_failed_version: null });
  assert.equal(db.prepare("SELECT link_deleted FROM deployments").get().link_deleted, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM visits").get().n, 0);
  db.prepare("INSERT INTO operations(id,publication_id,action,status,confirmation,revision,created_at,updated_at) VALUES('o1','p','remove','dns','{}','r','d','d')").run();
  assert.throws(() => db.prepare("INSERT INTO operations(id,publication_id,action,status,confirmation,revision,created_at,updated_at) VALUES('o2','p','publish','prepared','{}','r','d','d')").run(), /UNIQUE/, "the dns step counts as active");
 } finally {
  db.close();
 }
});

function readMigration(name) {
 return readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8");
}

// ------------------------------------------- 0.6.0 review findings (fixed)

test("review 1: a token that lost its DNS permission is not 'refused': domain and site removal finish and name the record left", async (t) => {
 const x = await setup(t);
 await x.control({ addZone: { accountId: ACCT_A, name: "example.com" } });
 await x.publish("q3-report", 2);
 await x.publish("checkout-flow", 1);
 const a = await x.site("q3-report");
 const b = await x.site("checkout-flow");
 await x.confirm(await x.svc.prepare({ action: "domain-add", publicationId: a.id, hostname: "docs.example.com" }));
 await x.confirm(await x.svc.prepare({ action: "domain-add", publicationId: b.id, hostname: "flow.example.com" }));
 await x.control({ denyDnsWrite: true });

 const op = await x.confirm(await x.svc.prepare({ action: "domain-remove", publicationId: a.id, hostname: "docs.example.com" }));
 assert.equal(op.status, "removed");
 assert.match(JSON.parse(op.warnings)[0].message, /The token cannot edit DNS in example\.com any more, so the CNAME record docs\.example\.com → q3-revenue-report\.pages\.dev was left in place\. Delete it in Cloudflare/);
 assert.equal((await x.svc.connectionState()).status, "ready", "the main token is not marked refused");

 const rm = await x.confirm(await x.svc.prepare({ action: "remove", publicationId: b.id }));
 assert.equal(rm.status, "removed");
 assert.match(JSON.parse(rm.warnings)[0].message, /flow\.example\.com → checkout-flow\.pages\.dev was left in place/);
 assert.ok(x.h.inboxNotes.some((n) => /Delete a DNS record left by Checkout Flow/.test(n.title)));
 assert.equal((await x.svc.connectionState()).status, "ready");
});

test("review 2: turning Keep up to date off on a restore is decided at prepare, so a failed artifact read cannot leave it on", async (t) => {
 const x = await setup(t);
 await x.publish("q3-report", 1);
 await x.publish("q3-report", 2);
 const pub = await x.site("q3-report");
 await x.confirm(await x.svc.prepare({ action: "keep", publicationId: pub.id }));
 await x.settle();
 const op = await x.svc.prepare({ action: "rollback", publicationId: pub.id, version: 1 });
 assert.match(x.svc.op(op.id).keep_off, /Turned off when version 1 was restored/);
 const source = x.svc.source.bind(x.svc);
 x.svc.source = async () => {
  throw new RemoteError("COGNIX[WS] is busy.", 502);
 };
 await x.confirm(op);
 x.svc.source = source;
 const s = await x.site("q3-report");
 assert.equal(s.version, 1);
 assert.equal(s.keepUpdated, false);
 await x.svc.syncRound();
 await x.settle();
 assert.equal((await x.site("q3-report")).version, 1);
});

test("review 3: a domain add whose Check result meets a refusal fails and frees the site", async (t) => {
 const transport = losing((url, init) => init.method === "POST" && url.endsWith("/pages/projects/q3-revenue-report/domains"));
 const x = await setup(t, { transport });
 await x.publish("q3-report", 2);
 await x.publish("checkout-flow", 1);
 const pub = await x.site("q3-report");
 const op = await x.confirm(await x.svc.prepare({ action: "domain-add", publicationId: pub.id, hostname: "taken.partner.io" }));
 assert.equal(op.status, "unknown");
 // Meanwhile the name went to another site: Cloudflare now refuses it.
 const mine = x.project("q3-revenue-report").customDomains;
 const d = mine.get("taken.partner.io");
 mine.delete("taken.partner.io");
 x.project("checkout-flow").customDomains = new Map([["taken.partner.io", d]]);
 x.svc.reconcile(op.id);
 await x.settle();
 const after = x.svc.op(op.id);
 assert.equal(after.status, "failed");
 assert.match(after.error, /Cloudflare refused taken\.partner\.io/);
 assert.deepEqual((await x.site("q3-report")).domains, []);
 assert.equal((await x.confirm(await x.svc.prepare({ action: "remove", publicationId: pub.id }))).status, "removed");
});

test("review 4: a dropped connection during an automatic publish is retried next round, not recorded as a refused version", async (t) => {
 const transport = losing((url) => url.endsWith("/pages/assets/check-missing"), false);
 const x = await setup(t, { transport });
 await x.publish("q3-report", 2);
 const pub = await x.site("q3-report");
 await x.confirm(await x.svc.prepare({ action: "keep", publicationId: pub.id }));
 await x.settle();
 transport.arm();
 x.addVersion("q3-report", 3);
 await x.svc.syncRound();
 await x.settle();
 let s = await x.site("q3-report");
 assert.equal(s.version, 2);
 assert.equal(s.syncFailedVersion, null);
 assert.match(s.syncNote, /Version 3 could not be published just now .*Sites tries again shortly/);
 await x.svc.syncRound();
 await x.settle();
 s = await x.site("q3-report");
 assert.equal(s.version, 3);
 assert.equal(s.syncNote, null);
});

test("review 4b: a token refused during the upload pauses Keep up to date instead of failing the version", async (t) => {
 let refuse = false;
 const transport = async (url, init) => {
  if (refuse && String(url).endsWith("/upload-token")) {
   refuse = false;
   return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403, headers: { "Content-Type": "application/json" } });
  }
  return fetch(url, init);
 };
 const x = await setup(t, { transport });
 await x.publish("q3-report", 2);
 const pub = await x.site("q3-report");
 await x.confirm(await x.svc.prepare({ action: "keep", publicationId: pub.id }));
 await x.settle();
 refuse = true;
 x.addVersion("q3-report", 3);
 await x.svc.syncRound();
 await x.settle();
 let s = await x.site("q3-report");
 assert.equal(s.version, 2);
 assert.equal(s.syncFailedVersion, null);
 assert.equal((await x.svc.connectionState()).expired, true);
 assert.equal((await x.svc.checkConnection()).status, "ready");
 await x.svc.syncRound();
 await x.settle();
 assert.equal((await x.site("q3-report")).version, 3);
});

test("review 5: Keep up to date turned off while a round prepares is never published", async (t) => {
 const x = await setup(t);
 await x.publish("q3-report", 2);
 const pub = await x.site("q3-report");
 await x.confirm(await x.svc.prepare({ action: "keep", publicationId: pub.id }));
 await x.settle();
 const prepare = x.svc.prepare.bind(x.svc);
 x.svc.prepare = async (args) => {
  const r = await prepare(args);
  if (args.actor === "auto") await x.svc.setKeep(pub.id, false);
  return r;
 };
 x.addVersion("q3-report", 3);
 const deploys = x.requests(/\/deployments$/, "POST").length;
 await x.svc.syncRound();
 await x.settle();
 assert.equal(x.requests(/\/deployments$/, "POST").length, deploys);
 const s = await x.site("q3-report");
 assert.equal(s.version, 2);
 assert.equal(s.operations[0].status, "cancelled");
});

test("review 6: a version published by hand settles a stale waiting note and Try again", async (t) => {
 const x = await setup(t);
 await x.publish("q3-report", 2);
 const pub = await x.site("q3-report");
 await x.confirm(await x.svc.prepare({ action: "keep", publicationId: pub.id }));
 await x.settle();
 x.addVersion("q3-report", 3, { capabilities: ["state"] });
 await x.svc.syncRound();
 await x.settle();
 assert.equal((await x.site("q3-report")).syncFailedVersion, 3);
 x.addVersion("q3-report", 4);
 const op = await x.svc.prepare({ artifactId: "q3-report", version: 4 });
 await x.confirm(op);
 let s = await x.site("q3-report");
 assert.equal(s.version, 4);
 assert.equal(s.syncNote, null);
 assert.equal(s.syncFailedVersion, null);
 assert.equal(s.keepUpdated, true);
});

test("review 7: Sites offers Keep up to date, Add domain and Delete link only on a published site", () => {
 const src = readFileSync(new URL("../ui/source.mjs", import.meta.url), "utf8");
 assert.match(src, /p\.hasProject && p\.status === "published" \? renderKeepRow\(p, canMutate\)/);
 assert.match(src, /renderDomains\(p, canMutate && p\.status === "published"\)/);
 assert.match(src, /const canDeleteLink = linkAlive && !isCurrent && canMutate && p\.status === "published";/);
});

test("review 9: preparing the same domain on two sites answers in words, not a database error", async (t) => {
 const x = await setup(t);
 await x.publish("q3-report", 2);
 await x.publish("checkout-flow", 1);
 const [a, b] = [await x.site("q3-report"), await x.site("checkout-flow")];
 await x.svc.prepare({ action: "domain-add", publicationId: a.id, hostname: "same.partner.io" });
 await assert.rejects(x.svc.prepare({ action: "domain-add", publicationId: b.id, hostname: "same.partner.io" }), (e) => e instanceof RemoteError && e.status === 409 && /Another change to same\.partner\.io is in progress/.test(e.message));
});

test("review 10: removing a site resumes after a lost answer in the DNS step and deletes the project once", async (t) => {
 const transport = losing((url, init) => init.method === "DELETE" && url.includes("/dns_records/"), false);
 const x = await setup(t, { transport });
 await x.control({ addZone: { accountId: ACCT_A, name: "example.com" } });
 await x.publish("q3-report", 2);
 const pub = await x.site("q3-report");
 await x.confirm(await x.svc.prepare({ action: "domain-add", publicationId: pub.id, hostname: "docs.example.com" }));
 transport.arm();
 const op = await x.confirm(await x.svc.prepare({ action: "remove", publicationId: pub.id }));
 assert.equal(op.status, "unknown");
 assert.equal(op.remote_phase, "dns");
 assert.ok(x.project("q3-revenue-report"), "the project is still there");
 x.svc.reconcile(op.id);
 await x.settle();
 assert.equal(x.svc.op(op.id).status, "removed");
 assert.equal(x.project("q3-revenue-report"), undefined);
 assert.equal(x.requests(new RegExp(`/accounts/${ACCT_A}/pages/projects/q3-revenue-report$`), "DELETE").length, 1);
 assert.equal([...x.fake.state.zones.values()][0].records.size, 0);
});

test("review N1: a record left by a lost DNS permission is still reported after a lost answer on the domain delete", async (t) => {
 const transport = losing((url, init) => init.method === "DELETE" && url.endsWith("/domains/docs.example.com"), false);
 const x = await setup(t, { transport });
 await x.control({ addZone: { accountId: ACCT_A, name: "example.com" } });
 await x.publish("q3-report", 2);
 const pub = await x.site("q3-report");
 await x.confirm(await x.svc.prepare({ action: "domain-add", publicationId: pub.id, hostname: "docs.example.com" }));
 await x.control({ denyDnsWrite: true });
 transport.arm();
 const op = await x.confirm(await x.svc.prepare({ action: "domain-remove", publicationId: pub.id, hostname: "docs.example.com" }));
 assert.equal(op.status, "unknown");
 x.svc.reconcile(op.id);
 await x.settle();
 const done = x.svc.op(op.id);
 assert.equal(done.status, "removed");
 assert.match(JSON.parse(done.warnings)[0].message, /docs\.example\.com → q3-revenue-report\.pages\.dev was left in place/);
 assert.ok(x.h.inboxNotes.some((n) => /Delete a DNS record left by Q3 Revenue Report/.test(n.title)));
});

test("review N3: repeated transient failures of an automatic publish back off instead of retrying every minute", async (t) => {
 const transport = losing((url) => url.endsWith("/pages/assets/check-missing"), false);
 const x = await setup(t, { transport });
 await x.publish("q3-report", 2);
 const pub = await x.site("q3-report");
 await x.confirm(await x.svc.prepare({ action: "keep", publicationId: pub.id }));
 await x.settle();
 x.addVersion("q3-report", 3);
 const attempts = () => x.requests(/\/pages\/assets\/check-missing$/, "POST").length;
 const start = attempts();
 for (let i = 0; i < 2; i++) {
  transport.arm();
  await x.svc.syncRound();
  await x.settle();
 }
 assert.equal(attempts(), start + 2, "first failure retried at the next round");
 await x.svc.syncRound();
 await x.settle();
 assert.equal(attempts(), start + 2, "the second failure waits before the next try");
 assert.equal((await x.site("q3-report")).version, 2);
 x.svc.syncBackoff.get(pub.id).until = 0;
 await x.svc.syncRound();
 await x.settle();
 assert.equal((await x.site("q3-report")).version, 3);
 assert.equal(x.svc.syncBackoff.has(pub.id), false);
});
