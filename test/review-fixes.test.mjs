// Tests for the 2026-11-23 review of v2 F1 (findings B1, B2, B4–B11). Each
// fails without its fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { Cloudflare } from "../cloudflare.mjs";
import { PagesService } from "../service.mjs";
import { scanBundleForSecrets } from "../scan.mjs";
import { startFakeCloudflare } from "./fake-cloudflare.mjs";
import { ACCT_A, applyMigrations, makeBundle, createFakeHost } from "./v2-host.mjs";

const tool = (name, args, context = { workspace: "ws-1", agent: "a-helper" }) => ({
 protocol: "picode-tools/1",
 capability: "pages",
 tool: name,
 arguments: args,
 context,
});

async function setup(t, { fakeOptions, hostSetup } = {}) {
 const fake = await startFakeCloudflare(fakeOptions);
 t.after(() => fake.close());
 const h = createFakeHost();
 hostSetup?.(h);
 const db = applyMigrations(new DatabaseSync(":memory:"));
 t.after(() => db.close());
 const svc = new PagesService({
  db,
  host: h.host,
  remote: (acct, tok) => new Cloudflare(acct, tok, fetch, fake.url),
  emit: () => Promise.resolve({ ok: true }),
 });
 await svc.checkSettings({
  values: { account_id: ACCT_A },
  secrets: { api_token: h.settings.api_token, access_api_token: h.settings.access_api_token },
 });
 return { fake, h, db, svc };
}

test("B1: agent tools only reach artifacts and sites of the calling agent's workspace", async (t) => {
 const { svc, fake, h } = await setup(t);
 const ws2 = { workspace: "ws-2", agent: "a-other" };

 // An agent in ws-1 cannot publish an artifact of ws-2 to the internet.
 const cross = await svc.runTool(tool("publish", { artifact: "other-ws-page" }));
 assert.equal(cross.isError, true);
 assert.match(cross.content[0].text, /not available in this agent's workspace/);
 assert.equal(fake.state.accounts.get(ACCT_A)?.projects.size || 0, 0, "nothing reached Cloudflare");
 assert.equal(svc.db.prepare("SELECT count(*) n FROM publications").get().n, 0);

 // A free agent (no workspace) cannot either.
 const free = await svc.runTool(tool("publish", { artifact: "q3-report" }, { agent: "a-free" }));
 assert.equal(free.isError, true);

 // Each workspace's agent publishes its own and sees only its own sites.
 assert.equal((await svc.runTool(tool("publish", { artifact: "q3-report" }))).isError, undefined);
 assert.equal((await svc.runTool(tool("publish", { artifact: "other-ws-page" }, ws2))).isError, undefined);
 const sites1 = await svc.runTool(tool("sites", {}));
 assert.deepEqual(sites1.structuredContent.sites.map((s) => s.artifact), ["q3-report"]);
 const sites2 = await svc.runTool(tool("sites", {}, ws2));
 assert.deepEqual(sites2.structuredContent.sites.map((s) => s.artifact), ["other-ws-page"]);

 // status and restore are scoped the same way, by artifact and by operation.
 const st = await svc.runTool(tool("status", { artifact: "other-ws-page" }));
 assert.equal(st.isError, true);
 const opId = svc.db.prepare("SELECT o.id FROM operations o JOIN publications p ON p.id=o.publication_id WHERE p.artifact_id='other-ws-page'").get().id;
 const stOp = await svc.runTool(tool("status", { operation: opId }));
 assert.equal(stOp.isError, true);
 assert.ok(!JSON.stringify(stOp).includes("other-ws-page"));
 const rs = await svc.runTool(tool("restore", { artifact: "other-ws-page", version: 1 }));
 assert.equal(rs.isError, true);
 assert.match(rs.content[0].text, /not available in this agent's workspace/);
 assert.equal(h.inboxNotes.filter((n) => /Other Team Pricing/.test(n.title)).length, 1, "only the ws-2 agent's own publish");
});

test("B2: an agent keeps an existing restricted site's readers; only the owner changes them", async (t) => {
 const { svc } = await setup(t);
 const first = await svc.runTool(tool("publish", { artifact: "private-notes", version: 1, access: "restricted", emails: ["reader@example.com"] }));
 assert.equal(first.isError, undefined, first.content?.[0]?.text);

 const swap = await svc.runTool(tool("publish", { artifact: "private-notes", version: 2, access: "restricted", emails: ["attacker@example.net"] }));
 assert.equal(swap.isError, true);
 const add = await svc.runTool(tool("publish", { artifact: "private-notes", version: 2, emails: ["reader@example.com", "attacker@example.net"] }));
 assert.equal(add.isError, true);
 let p = svc.db.prepare("SELECT * FROM publications WHERE artifact_id='private-notes'").get();
 assert.deepEqual(JSON.parse(p.access_emails), ["reader@example.com"]);
 assert.equal(p.version, 1);

 const same = await svc.runTool(tool("publish", { artifact: "private-notes", version: 2, emails: ["Reader@example.com"] }));
 assert.equal(same.isError, undefined, same.content?.[0]?.text);
 p = svc.db.prepare("SELECT * FROM publications WHERE artifact_id='private-notes'").get();
 assert.equal(p.version, 2);
 assert.deepEqual(JSON.parse(p.access_emails), ["reader@example.com"]);
});

test("B4: the key scan covers long single lines and files over 2 MiB", () => {
 const filler = "x".repeat(200 << 10);
 const minified = makeBundle("m", 1, [
  { path: "app.min.js", mime: "text/javascript", content: `var a="${filler}";var k="cfut_MinifiedSecretValue123456";var b="${filler}"` },
 ]);
 const w1 = scanBundleForSecrets(minified);
 assert.equal(w1.length, 1, "a key inside a 400 KiB single line is found");
 assert.equal(w1[0].line, 1);
 assert.ok(!JSON.stringify(w1).includes("MinifiedSecretValue"));

 const big = makeBundle("b", 1, [
  { path: "data.js", mime: "text/javascript", content: "// pad\n".repeat(400_000) + 'const key = "AKIAABCDEFGHIJKLMNOP";\n' },
 ]);
 const w2 = scanBundleForSecrets(big);
 assert.equal(w2.length, 1, "a key past 2 MiB is found");
 assert.equal(w2[0].line, 400_001);

 // A key straddling a 64 KiB window edge is still found once.
 const edge = (64 << 10) - 10;
 const straddle = makeBundle("s", 1, [{ path: "e.js", mime: "text/javascript", content: "y".repeat(edge) + " ghp_" + "A".repeat(30) + " end" }]);
 assert.equal(scanBundleForSecrets(straddle).length, 1);
});

test("B5: production reads no test API URL from the environment", () => {
 const prev = process.env.CLOUDFLARE_PAGES_TEST_API_URL;
 process.env.CLOUDFLARE_PAGES_TEST_API_URL = "http://127.0.0.1:9/";
 try {
  const cf = new Cloudflare(ACCT_A, "tok");
  assert.equal(cf.apiBase, "https://api.cloudflare.com/client/v4");
  assert.equal(cf.edgeBase, "");
 } finally {
  if (prev === undefined) delete process.env.CLOUDFLARE_PAGES_TEST_API_URL;
  else process.env.CLOUDFLARE_PAGES_TEST_API_URL = prev;
 }
 assert.equal(new Cloudflare(ACCT_A, "tok", fetch, "http://127.0.0.1:9").apiBase, "http://127.0.0.1:9/client/v4");
 assert.throws(() => new Cloudflare(ACCT_A, "tok", fetch, "http://example.com"), /loopback/);
});

test("B6: the Inbox FYI never names an agent by raw id", async (t) => {
 const { svc, h } = await setup(t);
 const r = await svc.runTool(tool("publish", { artifact: "q3-report" }, { workspace: "ws-1", agent: "a-7be757ca9efe5c94" }));
 assert.equal(r.isError, undefined, r.content?.[0]?.text);
 assert.equal(h.inboxNotes.length, 1);
 assert.match(h.inboxNotes[0].title, /^An agent published version 2 of Q3 Revenue Report$/);
 assert.equal(h.inboxNotes[0].workspaceId, "ws-1");
});

test("B7: an agent's publish that fails sends a failure FYI", async (t) => {
 const { svc, h, fake } = await setup(t);
 fake.state.failDeployStatus = 500;
 const r = await svc.runTool(tool("publish", { artifact: "q3-report" }));
 assert.equal(r.isError, true);
 await new Promise((res) => setTimeout(res, 20));
 assert.equal(h.inboxNotes.length, 1, "the owner hears about the failure");
 assert.match(h.inboxNotes[0].title, /^An agent could not publish version 2 of Q3 Revenue Report$/);
 assert.equal(h.inboxNotes[0].workspaceId, "ws-1");
});

test("B8: agent warnings[] come back for restricted sites too", async (t) => {
 const { svc } = await setup(t);
 const r = await svc.runTool(tool("publish", { artifact: "key-leak-page", access: "restricted", emails: ["reader@example.com"] }));
 assert.equal(r.isError, undefined, r.content?.[0]?.text);
 assert.equal(r.structuredContent.access, "restricted");
 assert.equal(r.structuredContent.warnings?.length, 2);
});

test("B9: a bad Access token does not block saving a good main token, and Sites names it", async (t) => {
 const { svc, h } = await setup(t);
 const res = await svc.checkSettings({
  values: { account_id: ACCT_A },
  secrets: { api_token: "cfut_fake_valid_token", access_api_token: "cfat_wrong" },
 });
 assert.equal(res.status, 200);
 assert.equal(res.body.valid, true);
 assert.equal(res.body.warning, "access_api_token");
 h.settings.access_api_token = "cfat_wrong";
 const access = await svc.accessSetupState();
 assert.equal(access.status, "error");
 assert.equal(access.field, "access_api_token");
 assert.match(access.message, /Access API token/);
 assert.equal((await svc.connectionState()).status, "ready");

 const bad = await svc.checkSettings({ values: { account_id: ACCT_A }, secrets: { api_token: "cfut_wrong" } });
 assert.equal(bad.status, 403);
 assert.equal(bad.body.field, "api_token");
});

test("B10: a refused agent publish leaves no draft site row", async (t) => {
 const { svc, fake } = await setup(t);
 await new Cloudflare(ACCT_A, "cfut_fake_valid_token", fetch, fake.url).createProject("taken-name");
 const r = await svc.runTool(tool("publish", { artifact: "q3-report", projectName: "taken-name" }));
 assert.equal(r.isError, true);
 assert.match(r.content[0].text, /already in use/);
 assert.equal(svc.db.prepare("SELECT count(*) n FROM publications").get().n, 0);
 const sites = await svc.runTool(tool("sites", {}));
 assert.equal(sites.structuredContent.sites.length, 0);
});

test("B10: a refused republish of a removed site restores its removed row", async (t) => {
 const { svc, fake } = await setup(t);
 assert.equal((await svc.runTool(tool("publish", { artifact: "q3-report" }))).isError, undefined);
 svc.db.prepare("UPDATE publications SET status='removed'").run();
 const before = svc.db.prepare("SELECT * FROM publications").get();
 await new Cloudflare(ACCT_A, "cfut_fake_valid_token", fetch, fake.url).createProject("taken-two");
 const r = await svc.runTool(tool("publish", { artifact: "q3-report", projectName: "taken-two" }));
 assert.equal(r.isError, true);
 assert.deepEqual(svc.db.prepare("SELECT * FROM publications").get(), before);
});

test("B11: one publish (review, prepare, execute) downloads the bundle once", async (t) => {
 const { svc, h } = await setup(t);
 const rev = await svc.review("q3-report", 2);
 assert.equal(rev.publishable, true);
 const op = await svc.prepare({ action: "publish", artifactId: "q3-report", version: 2 });
 await svc.confirm(op.id, op.revision);
 const done = await svc.waitForOperation(op.id);
 assert.equal(done.status, "published");
 assert.equal(h.siteFetches.length, 1, `bundle downloads: ${h.siteFetches.length}`);
 assert.equal(svc.bundleCache, null, "the bundle is dropped once its operation ends");
});
