import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { Cloudflare, RemoteError } from "../cloudflare.mjs";
import { PagesService } from "../service.mjs";
import { DASHBOARD_PERMISSION_LABELS, scanBundleForSecrets, shortSlug, tokenTemplateURL } from "../scan.mjs";
import { startFakeCloudflare } from "./fake-cloudflare.mjs";

import { ACCT_A, ACCT_B, CTX, applyMigrations, makeBundle, createFakeHost } from "./v2-host.mjs";

test("D7 & D8 & D11 helpers: short slugs, token URL labels, and non-blocking secret scan without echoing secrets", () => {
 assert.equal(shortSlug("Q3 Revenue Report!", "art-1234"), "q3-revenue-report");
 assert.equal(shortSlug("!", "abc987"), "site-abc987");
 assert.deepEqual(DASHBOARD_PERMISSION_LABELS, [
  "Cloudflare Pages: Edit",
  "Account Settings: Edit",
  "Account Analytics: Read",
 ]);

 const withAcct = tokenTemplateURL(ACCT_A);
 assert.match(withAcct, /^https:\/\/dash\.cloudflare\.com\/\?/);
 assert.match(withAcct, new RegExp(ACCT_A));
 assert.match(withAcct, /account_analytics/);

 const withoutAcct = tokenTemplateURL("");
 assert.match(withoutAcct, /^https:\/\/dash\.cloudflare\.com\/profile\/api-tokens\?/);

 const secretValue = "cfut_RealLookingSecretToken999999";
 const bundle = makeBundle("a1", 1, [
  { path: "index.html", content: `<!doctype html><script>window.k="${secretValue}"</script>` },
 ]);
 const warnings = scanBundleForSecrets(bundle);
 assert.equal(warnings.length, 1);
 assert.equal(warnings[0].file, "index.html");
 assert.equal(warnings[0].prefix, "cfut_…");
 assert.ok(!JSON.stringify(warnings).includes("RealLookingSecretToken"), "raw secret value must never be echoed");
});

test("D8 settingsCheck, 401/403 Reconnect state, and D13 backup-restore reconnect & account isolation", async (t) => {
 const fake = await startFakeCloudflare();
 t.after(() => fake.close());

 const h = createFakeHost();
 const db = applyMigrations(new DatabaseSync(":memory:"));
 t.after(() => db.close());
 const svc = new PagesService({
  db,
  host: h.host,
  remote: (acct, tok) => new Cloudflare(acct, tok, fetch, fake.url),
  emit: (name, data) => h.host("/events", 1 << 20, { name, data }),
 });

 // D8 settingsCheck validates draft values + secrets before saving.
 const badAcct = await svc.checkSettings({
  values: { account_id: "not-hex" },
  secrets: { api_token: "cfut_fake_valid_token" },
 });
 assert.equal(badAcct.status, 400);

 const badTok = await svc.checkSettings({
  values: { account_id: ACCT_A },
  secrets: { api_token: "cfut_wrong", access_api_token: "" },
 });
 assert.ok([401, 403].includes(badTok.status));

 const good = await svc.checkSettings({
  values: { account_id: ACCT_A },
  secrets: { api_token: "cfut_fake_valid_token", access_api_token: "cfat_fake_access_token" },
 });
 assert.equal(good.status, 200);
 assert.equal(good.body.valid, true);
 assert.equal((await svc.connectionState()).status, "ready");

 // Publish a site in ACCT_A via agent tool, then test account switch & backup-restore reconnect.
 const pubRes = await svc.runTool({
  protocol: "picode-tools/1",
  capability: "pages", context: CTX,
  tool: "publish",
  arguments: { artifact: "q3-report", version: 1 },
 });
 assert.equal(pubRes.isError, undefined);
 assert.equal(pubRes.structuredContent.status, "live");

 // D13: Switch active account to ACCT_B -> ACCT_A site is marked otherAccount and excluded from agent `sites`.
 h.settings.account_id = ACCT_B;
 h.settings.api_token = "cfut_fake_account_b";
 h.settings.access_api_token = "";
 await svc.checkSettings({
  values: { account_id: ACCT_B },
  secrets: { api_token: "cfut_fake_account_b", access_api_token: "" },
 });
 const stOther = await svc.state();
 assert.equal(stOther.publications[0].otherAccount, true);
 assert.equal(stOther.publications[0].siteStatus, "other-account");
 const revOther = await svc.review("q3-report", 2);
 assert.equal(revOther.publishable, false);
 assert.equal(revOther.refusal.code, "other-account");
 const agentSitesOther = await svc.runTool({
  protocol: "picode-tools/1",
  capability: "pages", context: CTX,
  tool: "sites",
  arguments: {},
 });
 assert.equal(agentSitesOther.structuredContent.sites.length, 0);

 // D13 backup restore: publications exist in SQLite, machine-bound token missing -> status === "reconnect".
 h.settings.account_id = ACCT_A;
 h.settings.api_token = "";
 const stReconnect = await svc.connectionState();
 assert.equal(stReconnect.status, "reconnect");

 // D8 401/403 token expiry -> status === "expired".
 h.settings.api_token = "cfut_fake_valid_token";
 await svc.checkConnection();
 assert.equal((await svc.connectionState()).status, "ready");
 fake.state.expiredTokens.add("cfut_fake_valid_token");
 await assert.rejects(() => svc.prepare({ action: "publish", artifactId: "q3-report", version: 2 }), /token|401|expired|refused/i);
 assert.equal((await svc.connectionState()).status, "expired");
});

test("D9, D10, D11, D12 & D3: Direct Upload, pruned Restore fallback, >100 deploy delete pruning, refusals, and executor round-trip", async (t) => {
 const fake = await startFakeCloudflare();
 t.after(() => fake.close());

 const tmpDir = mkdtempSync(join(tmpdir(), "cf-pages-v2-f1-"));
 t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

 const h = createFakeHost();

 const extToken = "ext-tok-test";
 const proxySecret = "proxy-sec-test";
 const hostServer = http.createServer(async (req, res) => {
  if (req.headers["x-picode-extension-token"] !== extToken) {
   res.writeHead(401, { "Content-Type": "application/json" });
   res.end(JSON.stringify({ error: "unauthorized" }));
   return;
  }
  const path = req.url.replace(/^\/api\/ext\/v1/, "");
  let body;
  if (req.method === "POST") {
   let raw = "";
   for await (const c of req) raw += c;
   body = JSON.parse(raw || "{}");
  }
  try {
   const out = await h.host(path, 192 << 20, body);
   res.writeHead(200, { "Content-Type": "application/json" });
   res.end(JSON.stringify(out));
  } catch (e) {
   res.writeHead(e.status || 500, { "Content-Type": "application/json" });
   res.end(JSON.stringify({ error: e.message }));
  }
 });
 await new Promise((r) => hostServer.listen(0, "127.0.0.1", r));
 t.after(() => hostServer.close());
 const hostPort = hostServer.address().port;

 const probe = http.createServer();
 await new Promise((r) => probe.listen(0, "127.0.0.1", r));
 const extPort = probe.address().port;
 await new Promise((r) => probe.close(r));

 const repoRoot = fileURLToPath(new URL("../", import.meta.url));
 const dbPath = join(tmpDir, "data.db");
 // Apply extension SQLite migrations just as COGNIX[WS] does before starting process.
 const initDb = applyMigrations(new DatabaseSync(dbPath));
 initDb.close();

 const proc = spawn(process.execPath, [join(repoRoot, "test", "serve-fake.mjs")], {
  env: {
   ...process.env,
   PICODE_URL: `http://127.0.0.1:${hostPort}`,
   PICODE_EXT_TOKEN: extToken,
   PICODE_EXT_PROXY_SECRET: proxySecret,
   PICODE_EXT_PORT: String(extPort),
   PICODE_EXT_DB: dbPath,
   PICODE_EXT_DATA: tmpDir,
   CLOUDFLARE_PAGES_FAKE_API_URL: fake.url,
  },
  stdio: ["ignore", "pipe", "pipe"],
 });
 t.after(() => {
  proc.kill("SIGTERM");
 });

 async function relay(path, body, extraHeaders = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
   const r = http.request(
    {
     host: "127.0.0.1",
     port: extPort,
     path,
     method: payload === undefined ? "GET" : "POST",
     headers: {
      "x-picode-proxy-secret": proxySecret,
      ...(payload !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
      ...extraHeaders,
     },
    },
    (res) => {
     let data = "";
     res.setEncoding("utf8");
     res.on("data", (c) => (data += c));
     res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data || "{}") }));
    },
   );
   r.on("error", reject);
   r.end(payload);
  });
 }

 for (let i = 0; i < 40; i++) {
  try {
   const r = await relay("/state");
   if (r.status === 200) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 50));
 }

 async function execTool(tool, args, agent = "a-helper", agentName = "Helper") {
  const reqJson = JSON.stringify({
   protocol: "picode-tools/1",
   capability: "pages",
   tool,
   arguments: args,
   context: { workspace: "ws-1", agent, agentName, dataDir: tmpDir },
  });
  return new Promise((resolve, reject) => {
   const child = spawn(process.execPath, [join(repoRoot, "execute.mjs")], {
    env: { ...process.env, PICODE_EXT_DATA: tmpDir },
    stdio: ["pipe", "pipe", "pipe"],
   });
   let out = "";
   child.stdout.on("data", (c) => (out += c));
   child.on("error", reject);
   child.on("close", () => resolve(JSON.parse(out)));
   child.stdin.end(reqJson);
  });
 }

 // Verify connection via /settings/check.
 const chk = await relay("/settings/check", {
  values: { account_id: h.settings.account_id },
  secrets: { api_token: h.settings.api_token, access_api_token: h.settings.access_api_token },
 });
 assert.equal(chk.status, 200);

 // D12 refusals in /artifacts/:id/review:
 const capRev = await relay("/artifacts/stateful-app/review");
 assert.equal(capRev.body.publishable, false);
 assert.equal(capRev.body.refusal.code, "local-capabilities");
 assert.deepEqual(capRev.body.refusal.capabilities, ["state", "picode"]);
 assert.equal(capRev.body.refusal.author, "a-builder");

 const docRev = await relay("/artifacts/arch-doc/review");
 assert.equal(docRev.body.publishable, false);
 assert.equal(docRev.body.refusal.code, "unsupported-kind");

 const brokenRev = await relay("/artifacts/broken-page/review");
 assert.equal(brokenRev.body.publishable, false);
 assert.equal(brokenRev.body.refusal.code, "bundle-invalid");

 // D12 design artifact + D7 short slug:
 const designRev = await relay("/artifacts/checkout-flow/review");
 assert.equal(designRev.body.publishable, true);
 assert.equal(designRev.body.suggestedProject, "checkout-flow");
 assert.equal(designRev.body.fileCount, 2);

 const designPub = await execTool("publish", { artifact: "checkout-flow" }, "a-designer", "Designer");
 assert.equal(designPub.isError, undefined);
 assert.equal(designPub.structuredContent.url, "https://checkout-flow.pages.dev/");
 assert.equal(h.inboxNotes.length, 1, "agent publish posts non-blocking Updates FYI to Inbox");
 assert.match(h.inboxNotes[0].title, /^An agent published version 1 of Checkout Flow/);
 assert.ok(!h.inboxNotes[0].title.includes("a-designer"), "the FYI never names an agent by raw id");

 // D11 non-blocking secret scan on agent publish returns warnings[] without blocking:
 const warnPub = await execTool("publish", { artifact: "key-leak-page" }, "a-helper", "Helper");
 assert.equal(warnPub.isError, undefined);
 assert.equal(warnPub.structuredContent.status, "live");
 assert.ok(Array.isArray(warnPub.structuredContent.warnings));
 assert.equal(warnPub.structuredContent.warnings.length, 2);
 assert.ok(!JSON.stringify(warnPub).includes("SuperSecretValue1234567890"));

 // D10 Restore: publish v1, update v2, prune v1 on Cloudflare, then restore v1 -> falls back to local re-upload!
 const r1 = await execTool("publish", { artifact: "q3-report", version: 1 });
 assert.equal(r1.structuredContent.version, 1);
 assert.equal(r1.structuredContent.url, "https://q3-revenue-report.pages.dev/");

 const stAfterV1 = await relay("/state");
 const q3PubV1 = stAfterV1.body.publications.find((p) => p.artifact_id === "q3-report");
 const v1DepId = q3PubV1.deployment;

 const r2 = await execTool("publish", { artifact: "q3-report", version: 2 });
 assert.equal(r2.structuredContent.version, 2);

 // Prune v1 deployment on the fake Cloudflare server (>30 days / >100 deploys simulation).
 const acctObj = fake.state.accounts.get(ACCT_A);
 const cfProj = acctObj.projects.get("q3-revenue-report");
 cfProj.deployments = cfProj.deployments.filter((d) => d.id !== v1DepId);

 const restored = await execTool("restore", { artifact: "q3-report", version: 1 }, "a-helper", "Helper");
 assert.equal(restored.isError, undefined);
 assert.equal(restored.structuredContent.status, "live");
 assert.equal(restored.structuredContent.version, 1);

 const stAfterRestore = await relay("/state");
 const q3AfterRestore = stAfterRestore.body.publications.find((p) => p.artifact_id === "q3-report");
 assert.equal(q3AfterRestore.version, 1);
 assert.equal(q3AfterRestore.undoVersion, 2, "undoVersion remembers v2 after restoring v1");

 // D3 human-only boundaries. B2: an agent cannot restrict an existing public
 // site or choose its readers; a new site may start restricted.
 const restrictExisting = await execTool("publish", {
  artifact: "q3-report",
  version: 2,
  access: "restricted",
  emails: ["reader@example.com"],
 });
 assert.equal(restrictExisting.isError, true);
 assert.match(restrictExisting.content[0].text, /requires the owner in Sites/i);

 const privPub = await execTool("publish", {
  artifact: "private-notes",
  version: 1,
  access: "restricted",
  emails: ["reader@example.com"],
 });
 assert.equal(privPub.isError, undefined, privPub.content?.[0]?.text);
 assert.equal(privPub.structuredContent.access, "restricted");

 const flipPublic = await execTool("publish", {
  artifact: "private-notes",
  version: 1,
  access: "public",
 });
 assert.equal(flipPublic.isError, true);
 assert.match(flipPublic.content[0].text, /requires the owner in Sites/i);

 const addReader = await execTool("publish", {
  artifact: "private-notes",
  version: 2,
  access: "restricted",
  emails: ["reader@example.com", "intruder@example.net"],
 });
 assert.equal(addReader.isError, true, "an agent cannot grant a new address on a restricted site");
 assert.match(addReader.content[0].text, /readers requires the owner in Sites/i);

 const keepReaders = await execTool("publish", { artifact: "private-notes", version: 2 });
 assert.equal(keepReaders.isError, undefined, keepReaders.content?.[0]?.text);
 assert.equal(keepReaders.structuredContent.access, "restricted");
 const notesPub = (await relay("/state")).body.publications.find((p) => p.artifact_id === "private-notes");
 assert.deepEqual(notesPub.access_emails, ["reader@example.com"], "a new version keeps the existing readers");

 const renameAttempt = await execTool("publish", {
  artifact: "checkout-flow",
  version: 1,
  projectName: "different-subdomain",
 });
 assert.equal(renameAttempt.isError, true);
 assert.match(renameAttempt.content[0].text, /requires the owner in Sites/i);

 const removeAttempt = await execTool("remove", { artifact: "checkout-flow" });
 assert.equal(removeAttempt.isError, true);

 // D3 `sites` and `status` bounded output:
 const sitesRes = await execTool("sites", { filter: "private" });
 assert.equal(sitesRes.isError, undefined);
 assert.equal(sitesRes.structuredContent.sites.length, 1);
 assert.equal(sitesRes.structuredContent.sites[0].artifact, "private-notes");

 const statusRes = await execTool("status", { artifact: "checkout-flow" });
 assert.equal(statusRes.isError, undefined);
 assert.equal(statusRes.structuredContent.status, "live");

 // D10 >100 deployments deletion guard: seed 105 deployments on checkout-flow and verify owner Remove prunes before delete.
 const checkoutProj = acctObj.projects.get("checkout-flow");
 for (let i = 0; i < 105; i++) {
  checkoutProj.deployments.push({
   id: `extra-dep-${i}`,
   url: `https://extra-${i}.checkout-flow.pages.dev`,
   environment: "preview",
   created_on: new Date().toISOString(),
   latest_stage: { name: "deploy", status: "success" },
   deployment_trigger: { metadata: { branch: "preview", commit_message: "picode:extra" } },
  });
 }
 assert.ok(checkoutProj.deployments.length > 100);
 const checkoutPub = (await relay("/state")).body.publications.find((p) => p.artifact_id === "checkout-flow");
 const prepRem = await relay("/prepare", { action: "remove", publicationId: checkoutPub.id });
 assert.equal(prepRem.status, 201);
 const confRem = await relay(
  "/__picode/confirm",
  { operationId: prepRem.body.id, revision: prepRem.body.confirmation.revision },
  { "x-picode-owner-confirmed": prepRem.body.confirmation.revision },
 );
 assert.equal(confRem.status, 202);
 for (let i = 0; i < 60; i++) {
  const op = (await relay(`/operations/${prepRem.body.id}`)).body;
  if (op.status === "removed" || op.status === "failed") {
   assert.equal(op.status, "removed");
   break;
  }
  await new Promise((r) => setTimeout(r, 30));
 }
 assert.equal(acctObj.projects.has("checkout-flow"), false);
});

test("Decision table: token state × deployment state × artifact kind → action", async (t) => {
 const fake = await startFakeCloudflare();
 t.after(() => fake.close());

 const rows = [
  { token: "missing", deploy: "new", kind: "page", op: "publish", expect: "blocked-not-configured" },
  { token: "missing", deploy: "live-active", kind: "page", op: "publish", expect: "blocked-reconnect" },
  { token: "expired", deploy: "new", kind: "page", op: "publish", expect: "blocked-expired" },
  { token: "expired", deploy: "live-active", kind: "design", op: "restore", expect: "blocked-expired" },
  { token: "valid", deploy: "new", kind: "page", op: "publish", expect: "published-direct-upload" },
  { token: "valid", deploy: "new", kind: "design", op: "publish", expect: "published-direct-upload" },
  { token: "valid", deploy: "new", kind: "page-with-capabilities", op: "publish", expect: "refused-local-capabilities" },
  { token: "valid", deploy: "new", kind: "document", op: "publish", expect: "refused-unsupported-kind" },
  { token: "valid", deploy: "live-active", kind: "page", op: "restore", expect: "restored-cloudflare-rollback" },
  { token: "valid", deploy: "live-pruned", kind: "page", op: "restore", expect: "restored-local-reupload" },
  { token: "valid", deploy: "live-pruned", kind: "design", op: "restore", expect: "restored-local-reupload" },
 ];

 for (const row of rows) {
  await t.test(`${row.token} × ${row.deploy} × ${row.kind} (${row.op}) → ${row.expect}`, async (st) => {
   const h = createFakeHost();
   h.putArtifact(
    {
     id: "design-two",
     title: "Design System Preview",
     kind: "design",
     liveVersion: 2,
     versions: [
      { n: 2, kind: "design", files: [{ path: "index.html" }] },
      { n: 1, kind: "design", files: [{ path: "index.html" }] },
     ],
    },
    {
     1: makeBundle("design-two", 1, [{ path: "index.html", content: "<!doctype html><h1>Design v1</h1>" }]),
     2: makeBundle("design-two", 2, [{ path: "index.html", content: "<!doctype html><h1>Design v2</h1>" }]),
    },
   );

   const tokName = `cfut_row_${Math.random().toString(36).slice(2, 10)}`;
   const projPrefix = Math.random().toString(36).slice(2, 7);
   fake.state.validTokens.add(tokName);
   h.settings.api_token = tokName;

   const db = applyMigrations(new DatabaseSync(":memory:"));
   st.after(() => db.close());
   const svc = new PagesService({
    db,
    host: h.host,
    remote: (acct, tok) => new Cloudflare(acct, tok, fetch, fake.url),
    emit: () => Promise.resolve({ ok: true }),
   });
   await svc.checkSettings({
    values: { account_id: h.settings.account_id },
    secrets: { api_token: tokName, access_api_token: h.settings.access_api_token },
   });

   const artId =
    row.kind === "design"
     ? "design-two"
     : row.kind === "page-with-capabilities"
       ? "stateful-app"
       : row.kind === "document"
         ? "arch-doc"
         : "q3-report";
   const chosenProj = `row-${projPrefix}`;

   let v1DepId = "";
   if (row.deploy !== "new") {
    const p1 = await svc.runTool({
     protocol: "picode-tools/1",
     capability: "pages", context: CTX,
     tool: "publish",
     arguments: { artifact: artId, version: 1, projectName: chosenProj },
    });
    assert.equal(p1.isError, undefined, p1.content?.[0]?.text);
    const pub1 = (await svc.state()).publications.find((p) => p.artifact_id === artId);
    v1DepId = pub1.deployment;

    const p2 = await svc.runTool({
     protocol: "picode-tools/1",
     capability: "pages", context: CTX,
     tool: "publish",
     arguments: { artifact: artId, version: 2 },
    });
    assert.equal(p2.isError, undefined, p2.content?.[0]?.text);

    if (row.deploy === "live-pruned") {
     const proj = fake.state.accounts.get(ACCT_A).projects.get(chosenProj);
     proj.deployments = proj.deployments.filter((d) => d.id !== v1DepId);
    }
   }

   if (row.token === "missing") {
    h.settings.api_token = "";
   } else if (row.token === "expired") {
    fake.state.expiredTokens.add(tokName);
   }

   if (row.expect === "blocked-not-configured") {
    assert.equal((await svc.connectionState()).status, "not-configured");
    const res = await svc.runTool({ protocol: "picode-tools/1", capability: "pages", context: CTX, tool: "publish", arguments: { artifact: artId, version: 1 } });
    assert.equal(res.isError, true);
    return;
   }
   if (row.expect === "blocked-reconnect") {
    assert.equal((await svc.connectionState()).status, "reconnect");
    const res = await svc.runTool({ protocol: "picode-tools/1", capability: "pages", context: CTX, tool: "publish", arguments: { artifact: artId, version: 2 } });
    assert.equal(res.isError, true);
    return;
   }
   if (row.expect === "blocked-expired") {
    const res = await svc.runTool({
     protocol: "picode-tools/1",
     capability: "pages", context: CTX,
     tool: row.op,
     arguments: { artifact: artId, version: 1 },
    });
    assert.equal(res.isError, true);
    assert.equal((await svc.connectionState()).status, "expired");
    return;
   }
   if (row.expect === "refused-local-capabilities") {
    const rev = await svc.review(artId, 1);
    assert.equal(rev.publishable, false);
    assert.equal(rev.refusal.code, "local-capabilities");
    const res = await svc.runTool({ protocol: "picode-tools/1", capability: "pages", context: CTX, tool: "publish", arguments: { artifact: artId, version: 1 } });
    assert.equal(res.isError, true);
    return;
   }
   if (row.expect === "refused-unsupported-kind") {
    const rev = await svc.review(artId, 1);
    assert.equal(rev.publishable, false);
    assert.equal(rev.refusal.code, "unsupported-kind");
    const res = await svc.runTool({ protocol: "picode-tools/1", capability: "pages", context: CTX, tool: "publish", arguments: { artifact: artId, version: 1 } });
    assert.equal(res.isError, true);
    return;
   }
   if (row.expect === "published-direct-upload") {
    const res = await svc.runTool({
     protocol: "picode-tools/1",
     capability: "pages", context: CTX,
     tool: "publish",
     arguments: { artifact: artId, version: 1, projectName: chosenProj },
    });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.equal(res.structuredContent.status, "live");
    return;
   }
   if (row.expect === "restored-cloudflare-rollback") {
    const beforeReqs = fake.state.requests.length;
    const res = await svc.runTool({ protocol: "picode-tools/1", capability: "pages", context: CTX, tool: "restore", arguments: { artifact: artId, version: 1 } });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    const usedRollback = fake.state.requests.slice(beforeReqs).some((r) => r.path.endsWith(`/${v1DepId}/rollback`));
    assert.equal(usedRollback, true, "uses Cloudflare /rollback when target deployment is still retained");
    return;
   }
   if (row.expect === "restored-local-reupload") {
    const beforeReqs = fake.state.requests.length;
    const res = await svc.runTool({ protocol: "picode-tools/1", capability: "pages", context: CTX, tool: "restore", arguments: { artifact: artId, version: 1 } });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    const newReqs = fake.state.requests.slice(beforeReqs);
    assert.equal(newReqs.some((r) => r.path.endsWith("/rollback")), false);
    assert.equal(
     newReqs.some((r) => r.method === "POST" && r.path.endsWith(`/projects/${chosenProj}/deployments`)),
     true,
     "re-uploads immutable local COGNIX[WS] artifact version when Cloudflare pruned the deployment",
    );
   }
  });
 }
});
