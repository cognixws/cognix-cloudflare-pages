// 0.5.1: which action is primary in each state of a site. One test per row of
// the table in docs/acceptance.md ("0.5.1 primary action table"); the rule is
// ui/actions.mjs, used by the review view and by Manage site.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { actionButtonsHTML, restoreOffered, seedForm, siteActions, siteState } from "../ui/actions.mjs";
import { Cloudflare } from "../cloudflare.mjs";
import { PagesService } from "../service.mjs";
import { startFakeCloudflare } from "./fake-cloudflare.mjs";
import { ACCT_A, applyMigrations, createFakeHost } from "./v2-host.mjs";

const pub = (over = {}) => ({
 id: "site-1",
 artifact_id: "art-1",
 status: "published",
 hasProject: true,
 version: 2,
 undoVersion: null,
 latestVersion: 2,
 access_mode: "public",
 access_emails: [],
 analytics: { url: "https://dash" },
 url: "https://site.pages.dev",
 history: [{ id: "d1", version: 1 }],
 ...over,
});
const same = (p) => ({ mode: p.access_mode, emails: p.access_emails, analytics: Boolean(p.analytics) });
const kinds = (list) => list.map((a) => `${a.kind}:${a.label}`);
const review = (p, selected, extra = {}) =>
 siteActions({ surface: "review", pub: p, selected, form: p ? same(p) : { mode: "public", emails: [], analytics: true }, accessReady: true, ...extra });
const manage = (p, extra = {}) => siteActions({ surface: "manage", pub: p, selected: p.latestVersion || 0, accessReady: true, ...extra });

test("row 1 new site: Publish vN, enabled, in review and Manage site", () => {
 const r = review(null, 1);
 assert.equal(r.state, "new");
 assert.deepEqual(r.primary, { kind: "publish", label: "Publish v1", version: 1, enabled: true });
 assert.deepEqual(r.secondary, []);
 const draft = pub({ status: "draft", hasProject: false, version: null, history: [], url: null });
 assert.equal(siteState(draft), "new");
 assert.deepEqual(manage(draft).primary, { kind: "publish", label: "Publish v2", version: 2, enabled: true });
});

test("row 2 live at latest, selected = live: no Publish; Open site leads (defect 1)", () => {
 const p = pub();
 const r = review(p, 2);
 assert.equal(r.state, "live");
 assert.equal(r.primary.kind, "open-site");
 assert.equal(r.primary.label, "Open site");
 assert.ok(!kinds([r.primary, ...r.secondary]).some((k) => k.startsWith("publish")), "no Publish v2 while v2 is live");
 assert.equal(r.sentence, "Version 2 is currently published.");
 const m = manage(p);
 assert.equal(m.primary.kind, "open-site");
 assert.deepEqual(kinds(m.secondary), ["copy-link:Copy link"]);
});

test("row 3 live, selected = live but access or analytics changed in the form: Publish vN applies the change", () => {
 const p = pub();
 for (const form of [
  { mode: "public", emails: [], analytics: false },
  { mode: "restricted", emails: ["a@example.com"], analytics: true },
 ]) {
  const r = siteActions({ surface: "review", pub: p, selected: 2, form, accessReady: true });
  assert.deepEqual(r.primary, { kind: "publish", label: "Publish v2", version: 2, enabled: true });
  assert.equal(r.sentence, "Version 2 is live; publishing it again applies the changed settings.");
 }
 // Same readers in another order or case are not a change.
 const rp = pub({ access_mode: "restricted", access_emails: ["a@example.com", "b@example.com"] });
 const r = siteActions({ surface: "review", pub: rp, selected: 2, form: { mode: "restricted", emails: ["B@example.com", "a@example.com"], analytics: true }, accessReady: true });
 assert.equal(r.primary.kind, "open-site");
});

test("row 4 live at older, a newer version selected: Publish vN replaces it", () => {
 const p = pub({ version: 1, latestVersion: 2 });
 const r = review(p, 2);
 assert.deepEqual(r.primary, { kind: "publish", label: "Publish v2", version: 2, enabled: true });
 assert.equal(r.sentence, "Version 1 is live; publishing replaces it with version 2.");
 const m = manage(p);
 assert.deepEqual(m.primary, { kind: "publish", label: "Publish v2", version: 2, enabled: true });
 assert.deepEqual(kinds(m.secondary), ["copy-link:Copy link", "open-site:Open site"]);
});

test("row 5 after a restore, the undo version selected: one action, Undo to vN; no Publish vN beside it (defect 2)", () => {
 const p = pub({ version: 1, undoVersion: 2, latestVersion: 2 });
 assert.equal(siteState(p), "restored");
 for (const r of [review(p, 2), manage(p)]) {
  assert.deepEqual(r.primary, { kind: "undo", label: "Undo to v2", version: 2, enabled: true });
  const all = kinds([r.primary, ...r.secondary]);
  assert.equal(all.filter((k) => k.endsWith("v2")).length, 1, `one action for v2: ${all}`);
  assert.equal(r.sentence, "Version 1 was restored; Undo switches the site back to version 2.");
 }
});

test("row 6 after a restore, the live (restored) version selected: Open site leads, Undo stays secondary", () => {
 const p = pub({ version: 1, undoVersion: 2, latestVersion: 2 });
 const r = review(p, 1);
 assert.equal(r.primary.kind, "open-site");
 assert.deepEqual(kinds(r.secondary), ["undo:Undo to v2"]);
 assert.equal(r.sentence, "Version 1 is currently published.");
});

test("row 7 after a restore, a newer version than the undo one: Publish vN leads, Undo to vU secondary", () => {
 const p = pub({ version: 1, undoVersion: 2, latestVersion: 3 });
 const m = manage(p);
 assert.deepEqual(m.primary, { kind: "publish", label: "Publish v3", version: 3, enabled: true });
 assert.deepEqual(kinds(m.secondary), ["copy-link:Copy link", "open-site:Open site", "undo:Undo to v2"]);
 const r = review(p, 3);
 assert.equal(r.primary.label, "Publish v3");
 assert.deepEqual(kinds(r.secondary), ["undo:Undo to v2"]);
});

test("row 8 removed: the primary says it publishes a new site (defect 3)", () => {
 // serializePublication keeps hasProject true after removal (identity is not cleared).
 const p = pub({ status: "removed", hasProject: true, version: 1, url: "https://site.pages.dev" });
 const m = manage(p);
 assert.equal(m.state, "removed");
 assert.deepEqual(m.primary, { kind: "new-site", label: "Publish again as a new site…", version: 2, enabled: true });
 assert.deepEqual(m.secondary, [], "no links to a removed address");
 assert.equal(m.sentence, "This site was removed; publishing again creates a new site.");
 const r = review(p, 2, { form: { mode: "public", emails: [], analytics: true } });
 assert.deepEqual(r.primary, { kind: "new-site", label: "Publish v2 as a new site", version: 2, enabled: true });
 assert.equal(r.sentence, "The earlier site was removed; publishing creates a new site at the address above.");
 // Removed, then a republication prepared and cancelled: the row is a draft
 // without a project but with history; it is still a new site.
 const cancelled = pub({ status: "draft", hasProject: false, version: null, url: null });
 assert.equal(siteState(cancelled), "removed");
 assert.equal(manage(cancelled).primary.label, "Publish again as a new site…");
 // Removed and the artifact deleted locally: nothing to publish.
 assert.equal(siteActions({ surface: "manage", pub: p, selected: 0, accessReady: true }).primary.kind, "none");
});

test("row 9 restricted pending setup: the change is held with the reason as text", () => {
 const p = pub({ access_mode: "restricted", access_emails: ["a@example.com"], version: 1, latestVersion: 2 });
 const m = manage(p, { accessReady: false });
 assert.deepEqual(m.primary, { kind: "publish", label: "Publish v2", version: 2, enabled: false });
 assert.equal(m.sentence, "Restricted access needs setup before this site can change.");
 assert.deepEqual(kinds(m.secondary), ["copy-link:Copy link", "open-site:Open site", "settings:Open settings"]);
 const r = review(p, 2, { accessReady: false });
 assert.equal(r.primary.enabled, false);
 // An undo of a restricted site waits too, and is not offered as a secondary.
 const restored = pub({ access_mode: "restricted", access_emails: ["a@example.com"], version: 1, undoVersion: 2, latestVersion: 3 });
 const rm = manage(restored, { accessReady: false });
 assert.equal(rm.primary.enabled, false);
 assert.ok(!rm.secondary.some((a) => a.kind === "undo"));
 // Live at the selected version: Open site still leads, nothing is held.
 assert.equal(review(pub({ access_mode: "restricted", access_emails: ["a@example.com"] }), 2, { accessReady: false }).primary.kind, "open-site");
 // New site, restricted chosen in the review: held; Manage site of a removed
 // restricted site only opens the review, where access is chosen again.
 const fresh = siteActions({ surface: "review", pub: null, selected: 1, form: { mode: "restricted", emails: ["a@example.com"] }, accessReady: false });
 assert.equal(fresh.primary.enabled, false);
 const gone = pub({ status: "removed", hasProject: false, access_mode: "restricted", url: null });
 assert.equal(manage(gone, { accessReady: false }).primary.enabled, true);
});

test("row 10 another account, an operation in progress or no connection: no primary; live links stay in Manage site", () => {
 for (const r of [manage(pub({ otherAccount: true })), manage(pub({ version: 1 }), { blocked: true })]) {
  assert.equal(r.primary.kind, "none");
  assert.deepEqual(kinds(r.secondary), ["copy-link:Copy link", "open-site:Open site"]);
 }
 assert.deepEqual(manage(pub({ status: "removed", hasProject: false, url: null }), { blocked: true }).secondary, []);
});

test("both views take their actions from ui/actions.mjs (one rule), and Enter submits only a publish", () => {
 const src = readFileSync(new URL("../ui/source.mjs", import.meta.url), "utf8");
 assert.match(src, /import \{ actionButtonsHTML, restoreOffered, seedForm, siteActions \} from "\.\/actions\.mjs";/);
 const reviewFn = src.slice(src.indexOf(" function renderReviewView() {"), src.indexOf(" function renderDetailView() {"));
 const detailFn = src.slice(src.indexOf(" function renderDetailView() {"), src.indexOf(" function renderListView() {"));
 assert.match(reviewFn, /siteActions\(\{\s*surface: "review"/);
 assert.match(detailFn, /siteActions\(\{\s*surface: "manage"/);
 assert.match(detailFn, /restoreOffered\(p, d\.version, /);
 // No hand-made Publish vN or Undo button is left in either view.
 for (const fn of [reviewFn, detailFn]) {
  assert.doesNotMatch(fn, />Publish v\$\{/);
  assert.doesNotMatch(fn, />Undo to v\$\{/);
 }
 assert.match(src, /primary\.kind === "publish" \|\| primary\.kind === "new-site"\) && primary\.enabled\) void dispatchAction\("publish"\)/);
 // Row 6 under the "Version N is live" banner: the banner carries Open site,
 // the footer keeps the secondary Undo (seen dropped in scratch QA).
 assert.match(reviewFn, /isLiveJustNow && reviewActions\.primary\.kind === "open-site"\s*\? renderActionButtons\(\{ \.\.\.reviewActions, primary: \{ kind: "none" \} \}, latestPub\)/);
});

async function setup(t) {
 const fake = await startFakeCloudflare();
 t.after(() => fake.close());
 const h = createFakeHost();
 const db = applyMigrations(new DatabaseSync(":memory:"));
 t.after(() => db.close());
 const svc = new PagesService({
  db,
  host: h.host,
  remote: (acct, tok) => new Cloudflare(acct, tok, fetch, fake.url),
  emit: () => Promise.resolve({ ok: true }),
 });
 await svc.checkSettings({ values: { account_id: ACCT_A }, secrets: { api_token: h.settings.api_token } });
 return { svc };
}

async function settle(svc, id) {
 for (let i = 0; i < 200; i++) {
  const op = svc.operation(id);
  if (["published", "removed", "failed", "unknown"].includes(op.status)) return op;
  await new Promise((r) => setTimeout(r, 10));
 }
 throw new Error("operation did not settle");
}

test("row 8 host confirm: republishing a removed site says it creates a new site, also after a cancelled confirm", async (t) => {
 const { svc } = await setup(t);
 const first = await svc.prepare({ artifactId: "q3-report", version: 1 });
 assert.equal(first.confirmation.title, "Publish version 1 to q3-revenue-report.pages.dev?");
 await svc.confirm(first.id, first.confirmation.revision);
 assert.equal((await settle(svc, first.id)).status, "published");
 const pubId = first.publication_id;
 const rem = await svc.prepare({ action: "remove", publicationId: pubId });
 await svc.confirm(rem.id, rem.confirmation.revision);
 assert.equal((await settle(svc, rem.id)).status, "removed");

 const again = await svc.prepare({ artifactId: "q3-report", version: 2 });
 assert.equal(again.confirmation.title, "Publish version 2 as a new site?");
 assert.match(again.confirmation.message, /^q3-revenue-report\.pages\.dev was removed, so this creates a new site: “Q3 Revenue Report”, version 2, at [a-z0-9-]+\.pages\.dev/);
 assert.equal(again.confirmation.confirmLabel, "Publish new site");
 svc.cancel(again.id);

 const state = await svc.state();
 const row = state.publications.find((p) => p.id === pubId);
 assert.equal(siteState(row), "removed", "a cancelled republication is still a new site");
 const third = await svc.prepare({ artifactId: "q3-report", version: 2 });
 assert.equal(third.confirmation.title, "Publish version 2 as a new site?");
 assert.equal(third.confirmation.confirmLabel, "Publish new site");
 await svc.confirm(third.id, third.confirmation.revision);
 assert.equal((await settle(svc, third.id)).status, "published");

 // Once live again, an update says nothing about a new site.
 const fourth = await svc.prepare({ artifactId: "q3-report", version: 1 });
 assert.match(fourth.confirmation.title, /^Publish version 1 to [a-z0-9-]+\.pages\.dev\?$/);
 assert.equal(fourth.confirmation.confirmLabel, "Publish");
 svc.cancel(fourth.id);
});

test("row 5 in the history list: no Restore for the live version or for the Undo version (visual review, 2026-11-23)", () => {
 const restored = pub({ version: 1, undoVersion: 2, latestVersion: 3 });
 assert.equal(restoreOffered(restored, 1), false, "v1 is live: a no-op");
 assert.equal(restoreOffered(restored, 2), false, "Undo to v2 is the one action for v2");
 assert.equal(restoreOffered(restored, 3), true);
 const live = pub({ version: 2, undoVersion: null });
 assert.equal(restoreOffered(live, 1), true);
 assert.equal(restoreOffered(live, 2), false);
 assert.equal(restoreOffered(pub({ status: "removed", hasProject: false }), 1), false);
});

// Independent review, 2026-11-23 (findings 1-5, 7). Each fails without its fix.

test("review F1: the form is seeded from the site on every review unless edited, so stale choices are not called changes", () => {
 assert.deepEqual(seedForm(null), { mode: "public", emails: "", analytics: true });
 assert.deepEqual(seedForm(pub({ analytics: null })), { mode: "public", emails: "", analytics: false });
 assert.deepEqual(seedForm(pub({ access_mode: "restricted", access_emails: ["a@example.com", "b@example.com"] })), {
  mode: "restricted",
  emails: "a@example.com, b@example.com",
  analytics: true,
 });
 assert.equal(seedForm(pub({ status: "removed", analytics: null })).analytics, true, "a removed site starts as a new one");
 const src = readFileSync(new URL("../ui/source.mjs", import.meta.url), "utf8");
 const open = src.slice(src.indexOf(" async function openReview("), src.indexOf(" async function prepareAndConfirm("));
 assert.match(open, /if \(switchingArtifact \|\| !formTouched\) \{\s*const seeded = seedForm\(data\.publication\);/);
 for (const edit of [/accessMode = id;\s*formTouched = true;/, /accessEmails = t\.value;\s*formTouched = true;/, /analyticsOn = Boolean\(t\.checked\);\s*formTouched = true;/]) {
  assert.match(src, edit);
 }
});

test("review F2: Undo is held on the site's access, a publish on the form's", () => {
 const restricted = pub({ access_mode: "restricted", access_emails: ["a@example.com"], version: 1, undoVersion: 2, latestVersion: 2 });
 // Form switched to public: Undo still uses the restricted site and waits.
 const r = siteActions({ surface: "review", pub: restricted, selected: 2, form: { mode: "public", emails: [], analytics: true }, accessReady: false });
 assert.equal(r.primary.kind, "publish", "the form changed, so Publish v2 applies it");
 assert.equal(r.primary.enabled, true, "a public publish does not need Access");
 const u = siteActions({ surface: "manage", pub: restricted, selected: 2, accessReady: false });
 assert.deepEqual([u.primary.kind, u.primary.enabled], ["undo", false]);
 // A public site with restricted chosen in the form: Undo is not hidden.
 const pubSite = pub({ version: 1, undoVersion: 2, latestVersion: 3 });
 const v = siteActions({ surface: "review", pub: pubSite, selected: 3, form: { mode: "restricted", emails: ["a@example.com"], analytics: true }, accessReady: false });
 assert.equal(v.primary.enabled, false);
 assert.ok(v.secondary.some((a) => a.kind === "undo"), "Undo keeps the public site's access and works");
});

test("review F3: history Restore is held like the header; the setup action follows the Access status", () => {
 const restricted = pub({ access_mode: "restricted", access_emails: ["a@example.com"], version: 2, latestVersion: 2 });
 assert.equal(restoreOffered(restricted, 1, false), false);
 assert.equal(restoreOffered(restricted, 1, true), true);
 assert.equal(restoreOffered(pub({ version: 2 }), 1, false), true, "a public site does not wait for Access");
 const older = pub({ access_mode: "restricted", access_emails: ["a@example.com"], version: 1, latestVersion: 2 });
 const unchecked = siteActions({ surface: "manage", pub: older, selected: 2, accessReady: false, accessSettings: false });
 assert.deepEqual(unchecked.secondary.at(-1), { kind: "check-setup", label: "Check setup" });
 assert.equal(unchecked.sentence, "Cloudflare Access is not verified yet; check it before this site can change.");
 const missing = siteActions({ surface: "manage", pub: older, selected: 2, accessReady: false, accessSettings: true });
 assert.deepEqual(missing.secondary.at(-1), { kind: "settings", label: "Open settings" });
 const src = readFileSync(new URL("../ui/source.mjs", import.meta.url), "utf8");
 assert.match(src, /restoreOffered\(p, d\.version, state\?\.accessSetup\?\.status === "ready"\)/);
 assert.match(actionButtonsHTML(unchecked, older, { surface: "manage" }), /<button type="button" data-action="access-setup">Check setup<\/button>/);
});

test("review F4: with an operation prepared the review has no publish primary, so Enter does nothing", () => {
 const r = siteActions({ surface: "review", pub: pub({ version: 1 }), selected: 2, form: same(pub()), accessReady: true, blocked: true });
 assert.equal(r.primary.kind, "none");
 const src = readFileSync(new URL("../ui/source.mjs", import.meta.url), "utf8");
 const reviewFn = src.slice(src.indexOf(" function renderReviewView() {"), src.indexOf(" function renderDetailView() {"));
 assert.match(reviewFn, /surface: "review",[\s\S]*?blocked: Boolean\(activeOp\),/);
});

test("review F5: the buttons rows 2, 5, 8 and 9 render, with their attributes", () => {
 const live = pub();
 assert.equal(
  actionButtonsHTML(siteActions({ surface: "manage", pub: live, selected: 2, accessReady: true }), live, { surface: "manage" }),
  '<button type="button" data-sync="copy" data-url="https://site.pages.dev" data-key="manage-site-1">Copy link</button>\n<button type="button" class="primary" data-sync="open-url" data-url="https://site.pages.dev">Open site</button>',
 );
 const restored = pub({ version: 1, undoVersion: 2 });
 const review5 = actionButtonsHTML(siteActions({ surface: "review", pub: restored, selected: 2, form: same(restored), accessReady: true }), restored);
 assert.equal(review5, '<button type="button" class="primary" data-action="undo-restore" data-id="site-1" data-version="2">Undo to v2</button>');
 assert.doesNotMatch(review5, /type="submit"/, "Enter cannot publish v2 beside Undo");
 const removed = pub({ status: "removed", version: 1 });
 assert.equal(
  actionButtonsHTML(siteActions({ surface: "manage", pub: removed, selected: 2, accessReady: true }), removed, { surface: "manage" }),
  '<button type="button" class="primary" data-action="open-review" data-id="art-1" data-version="2">Publish again as a new site…</button>',
 );
 assert.equal(
  actionButtonsHTML(siteActions({ surface: "review", pub: removed, selected: 2, form: { mode: "public", emails: [], analytics: true }, accessReady: true }), removed),
  '<button type="submit" class="primary">Publish v2 as a new site</button>',
 );
 const held = pub({ access_mode: "restricted", access_emails: ["a@example.com"], version: 1, latestVersion: 2 });
 assert.match(
  actionButtonsHTML(siteActions({ surface: "manage", pub: held, selected: 2, accessReady: false }), held, { surface: "manage" }),
  /<button type="button" class="primary" data-action="open-review" data-id="art-1" data-version="2" disabled>Publish v2<\/button>$/,
 );
 assert.match(actionButtonsHTML(siteActions({ surface: "review", pub: null, selected: 1, form: { mode: "public", emails: [] }, accessReady: true }), null, { busy: "publish" }), /disabled>Preparing…</);
 const src = readFileSync(new URL("../ui/source.mjs", import.meta.url), "utf8");
 assert.match(src, /return actionButtonsHTML\(actions, pub, \{ surface, busy, copiedKey \}\);/);
});
