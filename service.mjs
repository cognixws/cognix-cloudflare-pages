import { randomUUID, createHash } from "node:crypto";
import { RemoteError } from "./cloudflare.mjs";
import { PublicationAccess, accessConfig, accessHash } from "./access.mjs";
import { PublicationAnalytics, analyticsURL } from "./analytics.mjs";
import { scanBundleForSecrets, tokenTemplateURL, maskAccountId, shortSlug, DASHBOARD_PERMISSION_LABELS } from "./scan.mjs";
import { PublicationDomains, normalizeHostname } from "./domains.mjs";
import { PublicationVisits } from "./visits.mjs";

const active = ["prepared", "queued", "creating", "protecting", "analytics", "dns", "uploading", "deploying", "verifying", "removing", "rolling-back", "unknown"];
const ACTIONS = ["publish", "remove", "rollback", "access", "analytics", "rename", "domain-add", "domain-remove", "delete-link", "keep"];
// The background round (Keep up to date, domain checks, visits) runs at most
// once a minute; the page may nudge it sooner, at most every 15 seconds.
const BACKGROUND_MS = 60_000;
const NUDGE_MS = 15_000;
const PUBLISHABLE_KINDS = new Set(["page", "design"]);
const now = () => new Date().toISOString();
const digest = (x) => createHash("sha256").update(JSON.stringify(x)).digest("hex");

// A refusal that will repeat for this version (it is the version, or the
// request, that Cloudflare or COGNIX[WS] refused), as opposed to a dropped
// connection, a busy or failing service, or a refused token.
function definiteRefusal(e) {
 return e instanceof RemoteError && e.status >= 400 && e.status < 500 && ![401, 403, 408, 429].includes(e.status);
}

function identity(p) {
 return JSON.stringify({ id: p.id, created: p.created_on, name: p.name, branch: p.production_branch, source: p.source || null });
}

function publicURL(raw) {
 try {
  const u = new URL(raw);
  if (u.protocol === "https:" && u.hostname.endsWith(".pages.dev") && !u.username && !u.password) return u.href;
 } catch {}
 throw new RemoteError("Cloudflare did not return a Pages URL.");
}

function siteStatusOf(p, latestVersion, activeOp, lastOp, otherAccount) {
 if (p.status === "removed") return "removed";
 if (otherAccount) return "other-account";
 if (activeOp && !["prepared", "unknown"].includes(activeOp.status)) return "publishing";
 if (activeOp?.status === "unknown" || lastOp?.status === "failed") return "attention";
 if (p.status === "published" && latestVersion && p.version && latestVersion > p.version) return "update";
 if (p.status === "published") return "live";
 return "draft";
}

export class PagesService {
 constructor({ db, host, remote, emit = async () => {} }) {
  this.db = db;
  this.host = host;
  this.remote = remote;
  this.emit = emit;
  this.running = new Set();
  this.closing = false;
  this.connectionCheck = null;
  this.checkGeneration = 0;
  this.accessSetupCheck = null;
  this.accessCheckGeneration = 0;
  this.bundleCache = null;
  this.scanCache = new Map();
  this.access = new PublicationAccess({ db, remote, configuration: () => this.configuration() });
  this.analytics = new PublicationAnalytics({ db });
  this.domains = new PublicationDomains({ db });
  this.visits = new PublicationVisits({ db });
  this.syncing = false;
  this.syncBackoff = new Map(); // publicationId -> { version, attempts, until }
  this.backgroundAt = 0;
  this.backgroundRunning = false;
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
 }

 pub(id) { return this.db.prepare("SELECT * FROM publications WHERE id=?").get(id); }
 op(id) { return this.db.prepare("SELECT * FROM operations WHERE id=?").get(id); }
 event() { return this.emit("changed", {}).catch(() => {}); }

 set(id, status, extra = {}) {
  if (!["unknown", "failed"].includes(status)) extra = { ...extra, remote_phase: status };
  const entries = Object.entries(extra);
  this.db.prepare(`UPDATE operations SET status=?,updated_at=?${entries.map(([k]) => ", " + k + "=?").join("")} WHERE id=?`).run(status, now(), ...entries.map(([, v]) => v), id);
  void this.event();
 }

 recordAuthError(err, c) {
  if (!(err instanceof RemoteError) || ![401, 403].includes(err.status) || !c?.account || !c?.token) return;
  this.connectionCheck = {
   status: "expired",
   expired: true,
   checkedAt: now(),
   retryable: false,
   message: "Cloudflare refused the API token. Paste a new token in Settings to resume updates.",
   fingerprint: digest(c),
  };
 }

 async configuration() {
  const r = await this.host("/settings");
  return {
   account: r.values?.account_id ? String(r.values.account_id).trim() : "",
   token: r.secrets?.api_token || "",
   accessToken: r.secrets?.access_api_token || "",
   secretsUnreadable: Boolean(r.secretsUnreadable),
  };
 }

 // Checked settings hook (D8, ADR-0327): validates proposed settings and secret
 // updates before COGNIX[WS] writes them, and caches the verified connection.
 async checkSettings(body = {}) {
  const current = await this.configuration();
  const account = body?.values?.account_id !== undefined ? String(body.values.account_id || "").trim() : current.account;
  const secrets = body?.secrets && typeof body.secrets === "object" ? body.secrets : {};
  const token = "api_token" in secrets ? String(secrets.api_token || "") : current.token;
  const accessToken = "access_api_token" in secrets ? String(secrets.access_api_token || "") : current.accessToken;
  if (!/^[a-fA-F0-9]{32}$/.test(account) || !token) {
   return { status: 400, body: { valid: false } };
  }
  const merged = { account, token, accessToken, secretsUnreadable: false };
  const cf = this.remote(account, token);
  let analytics = "ready";
  let message = "Account access verified.";
  // Each secret is checked on its own: the main API token decides whether the
  // settings save; an Access token that fails is recorded for Sites (which
  // names it) and never blocks saving a good main token.
  try {
   await cf.checkConnection();
   if (typeof cf.rumSites === "function") {
    try {
     await cf.rumSites();
    } catch (e) {
     if (!(e instanceof RemoteError && [401, 403].includes(e.status))) throw e;
     analytics = "unavailable";
     message += " Web Analytics needs Account Settings: Edit (Account Settings Read and Write) on the token.";
    }
   }
  } catch (e) {
   const code = e instanceof RemoteError && [400, 401, 403, 409, 429].includes(e.status) ? e.status : 502;
   return { status: code, body: { valid: false, field: "api_token" } };
  }
  if (accessToken) this.accessSetupCheck = { ...(await this.checkAccessToken(account, accessToken)), fingerprint: digest(merged) };
  else this.accessSetupCheck = null;
  // D5: whether the token can read visits. It never blocks saving the token.
  const visits = await this.visits.probe(cf, account, digest(merged));
  if (visits === "permission") message += " Visits need Account Analytics: Read on the token.";
  this.connectionCheck = {
   status: "ready",
   checkedAt: now(),
   analytics,
   visits,
   message,
   fingerprint: digest(merged),
  };
  void this.event();
  return { status: 200, body: { valid: true, ...(this.accessSetupCheck?.status === "error" ? { warning: "access_api_token" } : {}) } };
 }

 // The optional Access token, checked apart from the main token (B9).
 async checkAccessToken(account, accessToken) {
  const refused = (message) => ({ status: "error", settingsRequired: true, field: "access_api_token", message });
  try {
   const ac = this.remote(account, accessToken);
   const org = (await ac.call(`/accounts/${account}/access/organizations`)).result;
   if (!org?.auth_domain || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(org.auth_domain)) {
    return refused("The Access API token works, but Zero Trust has no team domain yet. Finish Zero Trust setup in Cloudflare.");
   }
   const providers = (await ac.call(`/accounts/${account}/access/identity_providers`)).result;
   if (!Array.isArray(providers) || !providers.some((p) => p.type === "onetimepin" && p.id)) {
    return refused("The Access API token works, but One-time PIN login is off. Turn it on in Zero Trust.");
   }
   await ac.call(`/accounts/${account}/access/apps?per_page=1`);
   return { status: "ready", message: "Email-code login configured. Each active reader uses 1 Zero Trust seat." };
  } catch (e) {
   if (e instanceof RemoteError && [401, 403].includes(e.status)) {
    return refused("Cloudflare refused the Access API token. The main token is saved; paste a new Access token to restrict sites.");
   }
   return { status: "error", settingsRequired: false, field: "access_api_token", message: "The Access API token could not be checked. Check it again shortly." };
  }
 }

 // A read-only account check never proves write permission or publishes a site.
 async connectionState() {
  const c = await this.configuration();
  if (!c.account || !c.token) {
   const hasSites = this.db.prepare("SELECT count(*) n FROM publications").get()?.n > 0;
   if (hasSites && (c.account || c.secretsUnreadable)) {
    return {
     status: "reconnect",
     expired: true,
     retryable: false,
     message: "Published sites stay online on Cloudflare, but updates pause until you paste a token in Settings.",
    };
   }
   return { status: "not-configured" };
  }
  if (this.connectionCheck?.fingerprint === digest(c)) {
   return { ...this.connectionCheck, fingerprint: undefined };
  }
  return { status: "unchecked" };
 }

 async checkConnection() {
  const c = await this.configuration();
  const generation = ++this.checkGeneration;
  if (!c.account || !c.token) throw new RemoteError("Configure the Cloudflare account and API token.", 409);
  const cf = this.remote(c.account, c.token);
  let result = {
   status: "ready",
   checkedAt: now(),
   analytics: "ready",
   message: "Account access verified. Publishing requires Cloudflare Pages: Edit permission.",
  };
  try {
   await cf.checkConnection();
   try {
    await cf.rumSites();
   } catch (e) {
    if (!(e instanceof RemoteError && [401, 403].includes(e.status))) throw e;
    result.analytics = "unavailable";
    result.message += " Web Analytics needs Account Settings: Edit (Account Settings Read and Write) on the token.";
   }
   result.visits = await this.visits.probe(cf, c.account, digest(c));
   if (result.visits === "permission") result.message += " Visits need Account Analytics: Read on the token.";
  } catch (e) {
   const expired = e instanceof RemoteError && [401, 403].includes(e.status);
   result = {
    status: "error",
    expired,
    checkedAt: now(),
    retryable: !(e instanceof RemoteError && [400, 401, 403, 409].includes(e.status)),
    message: e instanceof RemoteError ? e.message : "Cloudflare could not be reached. Check the connection again.",
   };
  }
  if (generation === this.checkGeneration) this.connectionCheck = { ...result, fingerprint: digest(c) };
  await this.event();
  return this.connectionState();
 }

 async accessSetupState() {
  const c = await this.configuration();
  if (!c.accessToken) return { status: "not-configured" };
  if (this.accessSetupCheck?.fingerprint === digest(c)) return { ...this.accessSetupCheck, fingerprint: undefined };
  return { status: "unchecked" };
 }

 async checkAccessSetup() {
  const c = await this.configuration();
  const generation = ++this.accessCheckGeneration;
  let result;
  try {
   const { cf } = await this.access.setup({ account_id: c.account });
   await this.access.list(cf, { account_id: c.account });
   result = { status: "ready", message: "Email-code login configured. Access write permission is required." };
  } catch (e) {
   result = { status: "error", settingsRequired: [401, 403].includes(e.status), message: e instanceof RemoteError ? e.message : "Restricted access could not be checked." };
  }
  if (generation === this.accessCheckGeneration) this.accessSetupCheck = { ...result, fingerprint: digest(c) };
  await this.event();
  return this.accessSetupState();
 }

 async checkAccess(id) {
  const p = this.pub(id);
  if (!p || p.access_mode !== "restricted") throw new RemoteError("Choose a restricted site.", 400);
  const cf = await this.cloud(p);
  const project = await this.checkProject(cf, p);
  if (!project) throw new RemoteError("The project is missing.", 409);
  await this.access.verify(p, accessConfig({ mode: p.access_mode, emails: JSON.parse(p.access_emails) }), project, (await cf.deployments(p.project)).map((d) => d.url));
  this.db.prepare("UPDATE publications SET access_verified_at=? WHERE id=?").run(now(), p.id);
  await this.event();
  return { verified: true };
 }

 async finishAccess(p, op, project, recovery) {
  const config = op.access_config ? JSON.parse(op.access_config) : accessConfig();
  if (config.mode === "restricted") await this.access.ensure(p, config, project, op.access_snapshot ? JSON.parse(op.access_snapshot) : null, recovery);
  else if (p.access_app || p.access_attempt) await this.access.remove(p, op.access_snapshot ? JSON.parse(op.access_snapshot) : null, recovery);
  if (config.mode === "public" && JSON.parse(op.access_snapshot || "null")) await this.access.verifyPublic(await this.cloud(p), p, project);
  this.db.prepare("UPDATE publications SET access_mode=?,access_emails=?,access_verified_at=? WHERE id=?").run(config.mode, JSON.stringify(config.emails), config.mode === "restricted" ? now() : null, p.id);
 }

 async cloud(p) {
  const c = await this.configuration();
  if (c.account !== p.account_id) {
   throw new RemoteError(`This publication belongs to another Cloudflare account (${maskAccountId(p.account_id)}). Switch account in Settings.`, 409);
  }
  return this.remote(c.account, c.token);
 }

 async source(id) { return this.host("/artifacts/" + encodeURIComponent(id)); }
 // JSON base64 expands the core's 128 MiB raw package; leave metadata headroom.
 // Artifact versions are immutable, so one publish (review, prepare, execute)
 // downloads the bundle once: the last bundle is kept for a few minutes and
 // dropped when its operation ends. Scan results are kept by digest.
 async bundle(id, version) {
  const key = id + "@" + version;
  const hit = this.bundleCache;
  if (hit && hit.key === key && Date.now() - hit.at < 10 * 60_000) return hit.bundle;
  const bundle = await this.host("/artifacts/" + encodeURIComponent(id) + "/versions/" + version + "/site", 192 << 20);
  this.bundleCache = { key, bundle, at: Date.now() };
  return bundle;
 }
 dropBundle(id, version) {
  if (this.bundleCache?.key === id + "@" + version) this.bundleCache = null;
 }
 scan(bundle) {
  const key = bundle?.digest;
  if (key && this.scanCache.has(key)) return this.scanCache.get(key);
  const warnings = scanBundleForSecrets(bundle);
  if (key) {
   if (this.scanCache.size >= 32) this.scanCache.delete(this.scanCache.keys().next().value);
   this.scanCache.set(key, warnings);
  }
  return warnings;
 }

 serializePublication(p, artifacts, activeAccount) {
  const art = artifacts.find((a) => a.id === p.artifact_id) || null;
  const latestVersion = art?.liveVersion || null;
  const otherAccount = Boolean(activeAccount && p.account_id && p.account_id !== activeAccount && p.status !== "removed");
  const operations = this.db
   .prepare("SELECT id,action,version,status,error,updated_at,progress,warnings,actor,actor_name FROM operations WHERE publication_id=? ORDER BY created_at DESC LIMIT 20")
   .all(p.id)
   .map((o) => ({
    ...o,
    progress: o.progress ? JSON.parse(o.progress) : null,
    warnings: o.warnings ? JSON.parse(o.warnings) : [],
   }));
  const activeOp = operations.find((o) => active.includes(o.status)) || null;
  const lastOp = activeOp || operations[0] || null;
  const history = this.db
   .prepare("SELECT * FROM deployments WHERE publication_id=? ORDER BY created_at DESC")
   .all(p.id)
   .map((d) => ({ ...d, pruned: Boolean(d.pruned), link_deleted: undefined, linkDeleted: Boolean(d.link_deleted) }));
  return {
   ...p,
   identity: undefined,
   access_fingerprint: undefined,
   access_attempt: undefined,
   access_app: undefined,
   access_delete_attempt: undefined,
   access_emails: JSON.parse(p.access_emails),
   accessPending: !!p.access_attempt,
   analytics: p.analytics_tag ? { url: analyticsURL(p.account_id, p.analytics_tag) } : null,
   hasProject: !!p.identity,
   otherAccount,
   accountHint: maskAccountId(p.account_id),
   undoVersion: p.undo_version || null,
   latestVersion,
   artifactKind: art?.kind || "page",
   siteStatus: siteStatusOf(p, latestVersion, activeOp, lastOp, otherAccount),
   keep_updated: undefined,
   sync_note: undefined,
   sync_failed_version: undefined,
   keepUpdated: Boolean(p.keep_updated),
   syncNote: p.sync_note || null,
   syncFailedVersion: p.sync_failed_version || null,
   domains: this.domains.list(p).map((r) => this.domains.serialize(p, r)),
   visits: this.visits.forPublication(p),
   history,
   operations,
  };
 }

 async state() {
  let artifacts = [], error = "";
  try {
   artifacts = (await this.host("/artifacts")).artifacts || [];
  } catch {
   error = "Artifacts could not be loaded. Retry.";
  }
  const c = await this.configuration();
  const connection = await this.connectionState();
  const accessSetup = await this.accessSetupState();
  const pubs = this.db.prepare("SELECT * FROM publications ORDER BY created_at DESC").all();
  return {
   artifacts,
   error,
   accountHint: c.account ? maskAccountId(c.account) : "",
   tokenUrl: tokenTemplateURL(c.account),
   permissionLabels: DASHBOARD_PERMISSION_LABELS,
   connection,
   accessSetup,
   visits: this.visits.summary(digest(c)),
   publications: pubs.map((p) => this.serializePublication(p, artifacts, c.account)),
  };
 }

 // Structured artifact review for D1c, D7, D11, D12 and D13: returns whether
 // the selected version can be published, any local-capability / kind / bundle
 // refusal with its author, non-blocking key-format warnings, and the default
 // short slug address.
 async review(artifactId, requestedVersion = 0) {
  if (!artifactId || typeof artifactId !== "string") throw new RemoteError("Choose an artifact.", 400);
  const c = await this.configuration();
  const src = await this.source(artifactId);
  const artifact = src?.artifact;
  const versions = Array.isArray(src?.versions) ? src.versions : [];
  if (!artifact || !versions.length) throw new RemoteError("The artifact has no versions to publish.", 404);
  const targetN = Number.isSafeInteger(Number(requestedVersion)) && Number(requestedVersion) >= 1 ? Number(requestedVersion) : artifact.liveVersion || versions[0].n;
  const ver = versions.find((v) => v.n === targetN) || versions[0];
  const rawPub = this.db.prepare("SELECT * FROM publications WHERE artifact_id=?").get(artifactId) || null;
  const pub = rawPub ? this.serializePublication(rawPub, [artifact], c.account) : null;
  const suggestedProject = pub && pub.status !== "removed" ? pub.project : shortSlug(artifact.title, artifact.id);

  if (pub && pub.otherAccount) {
   return {
    artifact,
    versions,
    selectedVersion: ver.n,
    author: ver.author || "",
    authorName: ver.authorName || "",
    publication: pub,
    suggestedProject,
    publishable: false,
    warnings: [],
    fileCount: Array.isArray(ver.files) ? ver.files.length : 0,
    refusal: {
     code: "other-account",
     accountHint: pub.accountHint,
     version: ver.n,
    },
   };
  }

  const kind = ver.kind || artifact.kind || "page";
  if (!PUBLISHABLE_KINDS.has(kind)) {
   return {
    artifact,
    versions,
    selectedVersion: ver.n,
    author: ver.author || "",
    authorName: ver.authorName || "",
    publication: pub,
    suggestedProject,
    publishable: false,
    warnings: [],
    fileCount: Array.isArray(ver.files) ? ver.files.length : 0,
    refusal: {
     code: "unsupported-kind",
     kind,
     version: ver.n,
    },
   };
  }

  if (Array.isArray(ver.capabilities) && ver.capabilities.length > 0) {
   return {
    artifact,
    versions,
    selectedVersion: ver.n,
    author: ver.author || "",
    authorName: ver.authorName || "",
    publication: pub,
    suggestedProject,
    publishable: false,
    warnings: [],
    fileCount: Array.isArray(ver.files) ? ver.files.length : 0,
    refusal: {
     code: "local-capabilities",
     capabilities: ver.capabilities,
     version: ver.n,
     author: ver.author || "",
     authorName: ver.authorName || "",
    },
   };
  }

  try {
   const b = await this.bundle(artifactId, ver.n);
   const warnings = this.scan(b);
   const fileCount = (b.files || []).filter((f) => f.path !== "_headers").length;
   return {
    artifact,
    versions,
    selectedVersion: ver.n,
    author: ver.author || "",
    authorName: ver.authorName || "",
    publication: pub,
    suggestedProject,
    publishable: true,
    warnings,
    fileCount,
    refusal: null,
   };
  } catch (e) {
   return {
    artifact,
    versions,
    selectedVersion: ver.n,
    author: ver.author || "",
    authorName: ver.authorName || "",
    publication: pub,
    suggestedProject,
    publishable: false,
    warnings: [],
    fileCount: Array.isArray(ver.files) ? ver.files.length : 0,
    refusal: {
     code: "bundle-invalid",
     message: e instanceof RemoteError ? e.message : "This version could not be packaged as a static site.",
     version: ver.n,
     author: ver.author || "",
     authorName: ver.authorName || "",
    },
   };
  }
 }

 async allocateGeneratedProject(cf, title, id, avoidName = "") {
  const base = shortSlug(title, id);
  const suffix = () => `${base.slice(0, 35).replace(/-+$/g, "")}-${randomUUID().replaceAll("-", "").slice(0, 4)}`;
  if (avoidName && base === avoidName) return suffix();
  const localCollision = this.db.prepare("SELECT id FROM publications WHERE project=? AND id!=? AND status!='removed'").get(base, id);
  if (localCollision) return suffix();
  if (cf && typeof cf.getProject === "function") {
   const existing = await cf.getProject(base);
   if (existing) return suffix();
  }
  return base;
 }

 async prepare({ artifactId, version, action = "publish", publicationId, deployment, projectName, access, analytics, hostname, actor = "owner", actorName = "" }) {
  if (!ACTIONS.includes(action)) {
   throw new RemoteError("Choose publish, remove, rollback, access, analytics, rename, a domain change, a link deletion or Keep up to date.", 400);
  }
  if (analytics !== undefined && typeof analytics !== "boolean") {
   throw new RemoteError("Choose whether Web Analytics is on or off.", 400);
  }

  let p = publicationId ? this.pub(publicationId) : null;
  let bundle;
  let warnings = [];
  let reuploadRestore = false;
  // A row this call inserts or resets is undone if prepare fails before the
  // operation is recorded, so a refused call leaves no draft behind (B10).
  let undoRow = null;
  // Set when this publish recreates a removed site: the confirmation says so (0.5.1).
  let removedProject = null;
  // The artifact's latest version: a person's publish or restore of an older
  // one turns Keep up to date off, and the confirmation says so (D4).
  let latestVersion = 0;
  const c = await this.configuration();

  try {
   if (action === "publish") {
    if (projectName !== undefined && (typeof projectName !== "string" || !/^[a-z0-9][a-z0-9-]{0,57}$/.test(projectName))) {
     throw new RemoteError("Use a project name with lowercase letters, numbers and dashes (up to 58 characters).", 400);
    }
    if (typeof artifactId !== "string" || !Number.isSafeInteger(version) || version < 1) {
     throw new RemoteError("Choose an artifact version.", 400);
    }
    const src = await this.source(artifactId);
    latestVersion = Number(src?.artifact?.liveVersion) || 0;
    const verMeta = (src?.versions || []).find((v) => v.n === version);
    const kind = verMeta?.kind || src?.artifact?.kind || "page";
    if (!PUBLISHABLE_KINDS.has(kind)) {
     throw new RemoteError("Cloudflare Pages publishes standalone page and design artifacts.", 409);
    }
    if (Array.isArray(verMeta?.capabilities) && verMeta.capabilities.length > 0) {
     throw new RemoteError(`Version ${version} declares workspace capabilities (${verMeta.capabilities.join(", ")}); prepare a standalone version first.`, 409);
    }
    bundle = await this.bundle(artifactId, version);
    warnings = this.scan(bundle);

    if (!p) p = this.db.prepare("SELECT * FROM publications WHERE artifact_id=?").get(artifactId);
    // A row without a project that has deployment history is a removed site
    // whose republication was prepared and cancelled: still a new site.
    if (p && p.status !== "removed" && !p.identity) {
     removedProject = this.db.prepare("SELECT project FROM deployments WHERE publication_id=? ORDER BY created_at DESC LIMIT 1").get(p.id)?.project || null;
    }
    if (!p) {
     const cfNew = this.remote(c.account, c.token);
     const id = randomUUID();
     const allocated = projectName || (await this.allocateGeneratedProject(cfNew, src.artifact.title, id));
     p = { id, artifact_id: artifactId, title: src.artifact.title, account_id: c.account, project: allocated, created_at: now() };
     this.db
      .prepare("INSERT INTO publications(id,artifact_id,title,account_id,project,created_at,generated_name) VALUES(?,?,?,?,?,?,?)")
      .run(p.id, p.artifact_id, p.title, p.account_id, p.project, p.created_at, projectName ? 0 : 1);
     undoRow = { id: p.id, row: null };
     p = this.pub(p.id);
    } else if (p.status === "removed") {
     const cfRemoved = this.remote(c.account, c.token);
     const previousProject = p.project;
     removedProject = previousProject;
     undoRow = { id: p.id, row: { ...p } };
     const allocated = projectName || (await this.allocateGeneratedProject(cfRemoved, src.artifact.title || p.title, p.id, previousProject));
     this.db
      .prepare("UPDATE publications SET account_id=?,title=?,identity=NULL,project=?,generated_name=?,status='draft',version=NULL,digest=NULL,deployment=NULL,url=NULL,undo_version=NULL WHERE id=?")
      .run(c.account, src.artifact.title || p.title, allocated, projectName ? 0 : 1, p.id);
     p = this.pub(p.id);
    } else if (src?.artifact?.title && src.artifact.title !== p.title) {
     this.db.prepare("UPDATE publications SET title=? WHERE id=?").run(src.artifact.title, p.id);
     p = this.pub(p.id);
    }
    if (projectName && projectName !== p.project) {
     if (p.identity || this.db.prepare(`SELECT id FROM operations WHERE publication_id=? AND status IN (${active.map(() => "?").join(",")})`).get(p.id, ...active)) {
      throw new RemoteError("Keep the existing site's project name when updating it.", 409);
     }
     this.db.prepare("UPDATE publications SET project=?,generated_name=0 WHERE id=?").run(projectName, p.id);
     p = this.pub(p.id);
    }
    if (p.artifact_id !== artifactId) throw new RemoteError("This publication belongs to another artifact.", 409);
   }

   if (action === "rename") {
    if (typeof projectName !== "string" || !/^[a-z0-9][a-z0-9-]{0,57}$/.test(projectName)) {
     throw new RemoteError("Use a project name with lowercase letters, numbers and dashes (up to 58 characters).", 400);
    }
    if (!p) throw new RemoteError("The publication was not found.", 404);
    if (p.status !== "published" || !p.identity || !p.version || !p.digest) throw new RemoteError("Only a published site can change its address.", 409);
    if (p.access_mode === "restricted" || p.access_app || p.access_attempt) {
     throw new RemoteError("A restricted site cannot change address. Remove it and publish again under the new name.", 409);
    }
    if (projectName === p.project) throw new RemoteError("Choose a different project name.", 400);
    bundle = { digest: p.digest };
    version = p.version;
   }

   if (action === "analytics") {
    if (!p) throw new RemoteError("The publication was not found.", 404);
    if (p.status !== "published" || !p.identity) throw new RemoteError("Only a published site can change Web Analytics.", 409);
    if (analytics === undefined) throw new RemoteError("Choose whether Web Analytics is on or off.", 400);
    if (!!p.analytics_tag === analytics) {
     return {
      unchanged: true,
      action,
      publication: { ...p, identity: undefined, access_fingerprint: undefined, access_attempt: undefined, access_app: undefined, access_delete_attempt: undefined },
     };
    }
   }

   if (!p) throw new RemoteError("The publication was not found.", 404);
   if (this.db.prepare(`SELECT id FROM operations WHERE publication_id=? AND status IN (${active.map(() => "?").join(",")})`).get(p.id, ...active)) {
    throw new RemoteError("Finish or cancel the current operation first.", 409);
   }

   const config = accessConfig(access === undefined ? { mode: p.access_mode, emails: JSON.parse(p.access_emails) } : access);
   if (action !== "publish" && action !== "access" && access !== undefined) {
    throw new RemoteError("Change access separately from restore or removal.", 400);
   }
   // D6: custom domains belong to sites anyone with the link can open.
   if ((action === "publish" || action === "access") && config.mode === "restricted" && p.access_mode !== "restricted" && this.domains.list(p).length) {
    throw new RemoteError("Remove the custom domains first: a restricted site keeps to its .pages.dev address.", 409);
   }

   const cf = await this.cloud(p);
   let snapshot = null;
   let notes = "";
   const project = await cf.getProject(p.project);
   if (p.identity) {
    if (project && identity(project) !== p.identity) throw new RemoteError("The remote project identity changed. Review it in Cloudflare.", 409);
    if (!project && action !== "remove") throw new RemoteError("The remote project is missing. Remove the publication record before publishing again.", 409);
   } else if (project) {
    throw new RemoteError("The project name is already in use. Review it in Cloudflare.", 409);
   }
   if (action !== "publish" && !p.identity) throw new RemoteError("This site has not been created yet.", 409);
   let domainPlan = null;
   let linkTarget = null;
   if (["domain-add", "domain-remove", "delete-link", "keep"].includes(action)) {
    if (p.status !== "published" || !project) throw new RemoteError("Only a published site can change this.", 409);
    snapshot = { canonical: project.canonical_deployment?.id, identity: identity(project), domains: [...(project.domains || [])].sort() };
   }
   if (action === "domain-add") {
    const host = normalizeHostname(hostname);
    if (p.access_mode === "restricted" || p.access_app || p.access_attempt) {
     throw new RemoteError("Custom domains work on sites anyone with the link can open. This site is restricted, so it keeps its .pages.dev address.", 409);
    }
    if (this.activeDomainOp(p.account_id, host)) throw new RemoteError(`Another change to ${host} is in progress. Finish or cancel it first.`, 409);
    const taken = this.domains.row(p.account_id, host);
    if (taken) throw new RemoteError(taken.publication_id === p.id ? `${host} is already on this site.` : `${host} is already on another of your sites.`, 409);
    if ((project.domains || []).some((d) => String(d).toLowerCase() === host)) throw new RemoteError(`${host} is already on this site in Cloudflare.`, 409);
    if (this.domains.list(p).length >= 20) throw new RemoteError("A site can have up to 20 custom domains here.", 409);
    domainPlan = await this.domains.plan(cf, p, host);
   }
   if (action === "domain-remove") {
    const host = normalizeHostname(hostname);
    const row = this.domains.row(p.account_id, host);
    if (!row || row.publication_id !== p.id) throw new RemoteError(`${host} is not a custom domain of this site.`, 404);
    if (this.activeDomainOp(p.account_id, host)) throw new RemoteError(`Another change to ${host} is in progress. Finish or cancel it first.`, 409);
    domainPlan = { account: p.account_id, hostname: host, target: p.project + ".pages.dev", zone: row.zone_id ? { id: row.zone_id, name: row.zone_name } : null, dns: row.dns, owned: Boolean(row.dns_owned) };
   }
   // D10: each version keeps its own link; the person may delete one that is not live.
   if (action === "delete-link") {
    linkTarget = this.db.prepare("SELECT * FROM deployments WHERE publication_id=? AND id=?").get(p.id, String(deployment || ""));
    if (!linkTarget) throw new RemoteError("Choose a version link from this site's history.", 400);
    if (linkTarget.project !== p.project || linkTarget.pruned || linkTarget.link_deleted) throw new RemoteError("This link no longer exists on Cloudflare.", 409);
    if (linkTarget.id === p.deployment || project.canonical_deployment?.id === linkTarget.id) throw new RemoteError("The live version's link cannot be deleted.", 409);
    version = linkTarget.version;
   }
   if (action === "keep") {
    if (p.keep_updated) return { unchanged: true, action, publication: { id: p.id, keepUpdated: true } };
    latestVersion = Number((await this.source(p.artifact_id))?.artifact?.liveVersion) || 0;
   }
   if ((action === "publish" || action === "access" || action === "analytics") && p.identity && project) {
    snapshot = { canonical: project.canonical_deployment?.id, identity: identity(project), domains: [...(project.domains || [])].sort() };
   }

   if (action === "remove" && project) {
    const deployments = await cf.deployments(p.project);
    snapshot = { identity: identity(project), domains: [...(project.domains || [])].sort(), deployments: deployments.map((d) => d.id).sort() };
    const external = deployments.filter((d) => !String(d.deployment_trigger?.metadata?.commit_message || "").startsWith("picode:"));
    notes = ` Removes ${deployments.length} deployments and their preview URLs.`;
    const domains = (project.domains || []).filter((d) => !d.endsWith(".pages.dev"));
    if (domains.length) notes += " Custom domains: " + domains.join(", ") + ".";
    if (external.length) notes += " Includes " + external.length + " deployments created outside this extension.";
    const managed = this.domains.list(p);
    const owned = managed.filter((r) => r.dns_owned).map((r) => r.hostname);
    const theirs = managed.filter((r) => !r.dns_owned).map((r) => r.hostname);
    if (owned.length) notes += ` Deletes the CNAME record${owned.length > 1 ? "s" : ""} Sites created for ${owned.join(", ")} first.`;
    if (theirs.length) notes += ` Then delete the CNAME record for ${theirs.join(", ")} at its DNS provider, so the name does not point to a removed site.`;
   }

   if (action === "rename") {
    if (this.domains.list(p).length || (project.domains || []).some((d) => !String(d).toLowerCase().endsWith(".pages.dev"))) {
     throw new RemoteError("Remove the custom domains first: they point at the current address.", 409);
    }
    if (await cf.getProject(projectName)) throw new RemoteError("The new project name is already in use. Choose another name.", 409);
    const deployments = await cf.deployments(p.project);
    snapshot = { canonical: project.canonical_deployment?.id, identity: identity(project), domains: [...(project.domains || [])].sort(), newName: projectName, oldTag: p.analytics_tag || null };
    notes = ` The current address ${p.project}.pages.dev and its ${deployments.length} deployment URL${deployments.length === 1 ? "" : "s"} stop working. Version history moves to the new address.`;
   }

   // D10 Restore: uses /rollback when the deployment still exists on Cloudflare,
   // and falls back to re-uploading the immutable local COGNIX[WS] artifact
   // version when Cloudflare pruned the deployment (>30 days / >100 deploys).
   if (action === "rollback") {
    let target = null;
    if (deployment) {
     target = this.db.prepare("SELECT * FROM deployments WHERE publication_id=? AND id=?").get(p.id, deployment);
     if (!target) throw new RemoteError("Choose a publication from this site's history.", 400);
    } else if (Number.isSafeInteger(version) && version >= 1) {
     target = this.db.prepare("SELECT * FROM deployments WHERE publication_id=? AND version=? ORDER BY created_at DESC LIMIT 1").get(p.id, version) || null;
     if (!target) throw new RemoteError("Choose a previously published version of this site.", 400);
     deployment = target.id;
    } else {
     throw new RemoteError("Choose a publication from this site's history.", 400);
    }

    let remoteDep = null;
    if (target.project === p.project && !target.pruned) {
     try {
      remoteDep = await cf.deployment(p.project, target.id);
     } catch (e) {
      if (e instanceof RemoteError && e.status === 404) {
       this.db.prepare("UPDATE deployments SET pruned=1 WHERE id=?").run(target.id);
       remoteDep = null;
      } else {
       throw e;
      }
     }
    }

    if (remoteDep) {
     if (remoteDep.environment !== "production" || remoteDep.latest_stage?.status !== "success") {
      throw new RemoteError("Only successful production publications can be restored.", 409);
     }
     version = target.version;
     bundle = { digest: target.digest };
     snapshot = { canonical: project.canonical_deployment?.id, identity: identity(project), domains: [...(project.domains || [])].sort(), reupload: false, previousVersion: p.version };
    } else {
     // Pruned by Cloudflare (>30 days or >100 deploys): re-upload immutable local copy.
     const localBundle = await this.bundle(p.artifact_id, target.version);
     if (target.digest && localBundle.digest !== target.digest) {
      throw new RemoteError("The local artifact version no longer matches the published digest.", 409);
     }
     reuploadRestore = true;
     deployment = null;
     version = target.version;
     bundle = localBundle;
     snapshot = { canonical: project.canonical_deployment?.id, identity: identity(project), domains: [...(project.domains || [])].sort(), reupload: true, previousVersion: p.version };
    }
   }

   const accessSnapshot = await this.access.snapshot(p);
   if (config.mode === "restricted" && !["remove", "domain-remove", "delete-link", "keep"].includes(action)) {
    const { cf: ac } = await this.access.setup(p);
    await this.access.conflicts(ac, p, project ? [p.project + ".pages.dev", "*." + p.project + ".pages.dev", ...(project.domains || [])] : [p.project + ".pages.dev", "*." + p.project + ".pages.dev"]);
   }

   const opAnalytics = action === "publish" ? (analytics === undefined ? !!p.analytics_tag : analytics) : action === "analytics" ? analytics : !!p.analytics_tag;
   if (
    action === "publish" &&
    p.status === "published" &&
    p.digest === bundle.digest &&
    p.access_mode === config.mode &&
    p.access_emails === JSON.stringify(config.emails) &&
    !!p.analytics_tag === !!opAnalytics &&
    project &&
    identity(project) === p.identity &&
    project.canonical_deployment?.id === p.deployment
   ) {
    if (config.mode === "restricted") await this.access.verify(p, config, project);
    return {
     unchanged: true,
     action,
     warnings,
     publication: { ...p, identity: undefined, access_app: undefined, access_fingerprint: undefined, access_attempt: undefined, access_delete_attempt: undefined },
    };
   }

   const coverage = config.mode === "restricted" ? ` Covered hostnames: ${[p.project + ".pages.dev", "*." + p.project + ".pages.dev", ...(project?.domains || [])].join(", ")}.` : "";
   const id = randomUUID();
   const audience =
    config.mode === "public"
     ? "Anyone with the link can access this site and its previous deployment URLs (preview links last up to 30 days)."
     : "Only these email addresses may sign in: " + config.emails.join(", ") + ". Production and preview URLs require an email code (1 Zero Trust seat per active reader).";

   // D4: a person's publish or restore of a version older than the latest
   // turns Keep up to date off (Render's rollback rule), and says so here.
   // A restore always turns it off (it pins a version); a publish does when
   // the version is older than the latest. Decided here and stored on the
   // operation, so finishing it needs no second read of the artifact.
   const keepOff =
    p.keep_updated && !String(actor).startsWith("auto") && (action === "rollback" || (action === "publish" && latestVersion && version < latestVersion))
     ? action === "rollback"
       ? `Turned off when version ${version} was restored. Turn it on again to follow new versions.`
       : `Turned off when version ${version} replaced the latest version ${latestVersion}. Turn it on again to follow new versions.`
     : null;
   const keepNote = keepOff ? ` Keep up to date turns off, so the site stays on version ${version}.` : "";
   const restoreMessage = (reuploadRestore
    ? `Restore version ${version} on ${p.project}.pages.dev (re-uploaded from your local COGNIX[WS] artifact copy because Cloudflare pruned the older deployment).`
    : `Restore version ${version} on ${p.project}.pages.dev.`) + keepNote;

   const host = p.project + ".pages.dev";
   const custom =
    action === "domain-add"
     ? {
        title: `Add ${domainPlan.hostname} to this site?`,
        message:
         (domainPlan.dns === "auto"
          ? `Adds ${domainPlan.hostname} to “${p.title}” (${host}) and creates the CNAME record ${domainPlan.hostname} → ${host} in the ${domainPlan.zone.name} zone when the token may edit its DNS; otherwise Sites shows the record to add.`
          : domainPlan.dns === "existing"
            ? `Adds ${domainPlan.hostname} to “${p.title}” (${host}). The CNAME record ${domainPlan.hostname} → ${host} already exists in ${domainPlan.zone.name}.`
            : `Adds ${domainPlan.hostname} to “${p.title}” (${host}). Then add this record at the DNS provider of ${domainPlan.hostname}: CNAME ${domainPlan.hostname} → ${host}.${domainPlan.reason === "zone-permission" || domainPlan.reason === "dns-permission" ? " The token cannot edit this name's DNS, so Sites shows the record instead of creating it." : ""}`) +
         " Anyone with the link can open the site at this address too.",
        confirmLabel: "Add domain",
        danger: false,
       }
     : action === "domain-remove"
       ? {
          title: `Remove ${domainPlan.hostname} from this site?`,
          message: domainPlan.owned
           ? `${domainPlan.hostname} stops opening “${p.title}”. Sites deletes the CNAME record ${domainPlan.hostname} → ${host} it created (only if it is unchanged), then removes the domain from the site.`
           : `${domainPlan.hostname} stops opening “${p.title}”. Then delete the CNAME record for ${domainPlan.hostname} at its DNS provider, so the name does not point to a site that no longer claims it.`,
          confirmLabel: "Remove domain",
          danger: true,
         }
       : action === "delete-link"
         ? {
            title: `Delete the link of version ${version}?`,
            message: `${linkTarget.url} stops working. ${host} keeps showing version ${p.version}, and version ${version} can still be restored from COGNIX[WS].`,
            confirmLabel: "Delete link",
            danger: true,
           }
         : action === "keep"
           ? {
              title: `Keep “${p.title}” up to date?`,
              message:
               `Each new version of the artifact is published to ${host} without asking, with the site's current access (${p.access_mode === "restricted" ? "only its allowed readers" : "anyone with the link"}) and settings.` +
               (latestVersion > (p.version || 0) ? ` Version ${latestVersion} is newer than the live version ${p.version}; it is published right after you confirm.` : "") +
               " Restoring or publishing an older version turns this off. When an automatic publish fails, the site keeps its version and a note goes to Inbox › Updates.",
              confirmLabel: "Keep up to date",
              danger: false,
             }
           : null;

   const confirmation = custom || {
    title:
     action === "access"
      ? "Change site access?"
      : action === "remove"
        ? "Remove this site?"
        : action === "rollback"
          ? `Restore version ${version}?`
          : action === "analytics"
            ? analytics
              ? "Enable Web Analytics?"
              : "Disable Web Analytics?"
            : action === "rename"
              ? "Change the site address?"
              : removedProject
                ? `Publish version ${version} as a new site?`
                : `Publish version ${version} to ${p.project}.pages.dev?`,
    message:
     action === "remove"
      ? `Remove ${p.project} from Cloudflare account ${p.account_id}.${notes} The local artifact stays. Managed access protection is cleaned up only after site removal.`
      : action === "access"
        ? `Change access for “${p.title}” in Cloudflare account ${p.account_id}. ${audience}${coverage}`
        : action === "analytics"
          ? analytics
            ? `Enable Web Analytics for “${p.title}” (${p.project}.pages.dev)? Cloudflare adds its privacy-first beacon automatically from the next publication; the current publication counts after it is published again.`
            : `Disable Web Analytics for “${p.title}”? Publications stop reporting from the next one; the current publication keeps counting until it is published again. Analytics already collected remain in Cloudflare.`
          : action === "rename"
            ? `Publish “${p.title}”, version ${version}, to ${projectName}.pages.dev and remove ${p.project}.pages.dev in Cloudflare account ${p.account_id}.${notes} ${audience}`
            : action === "rollback"
              ? restoreMessage
              : removedProject
                ? `${removedProject}.pages.dev was removed, so this creates a new site: “${p.title}”, version ${version}, at ${p.project}.pages.dev in Cloudflare account ${maskAccountId(p.account_id)}. ${audience}${coverage}`
                : `Publish “${p.title}”, version ${version}, to ${p.project}.pages.dev in Cloudflare account ${maskAccountId(p.account_id)}. ${audience}${coverage}${keepNote}`,
    confirmLabel:
     action === "access"
      ? "Change access"
      : action === "remove"
        ? "Remove site"
        : action === "rollback"
          ? `Restore v${version}`
          : action === "analytics"
            ? analytics
              ? "Enable analytics"
              : "Disable analytics"
            : action === "rename"
              ? "Change address"
              : removedProject
                ? "Publish new site"
                : "Publish",
    danger: action === "remove" || action === "rename" || (p.access_mode === "restricted" && config.mode === "public"),
   };

   if (confirmation.message.length > 2000) {
    throw new RemoteError("The reader list or project changes are too large for one confirmation. Reduce the reader list or review Cloudflare.", 409);
   }
   const revision = digest({ id, confirmation, version, digest: bundle?.digest || null, snapshot, deployment: deployment || null, access: config, accessSnapshot, domain: domainPlan });
   confirmation.revision = revision;
   this.db
    .prepare(
     "INSERT INTO operations(id,publication_id,action,version,digest,deployment,status,confirmation,revision,snapshot,access_config,access_snapshot,analytics,actor,actor_name,warnings,domain_plan,keep_off,created_at,updated_at) VALUES(?,?,?,?,?,?,'prepared',?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
     id,
     p.id,
     action,
     version || null,
     bundle?.digest || null,
     deployment || null,
     JSON.stringify(confirmation),
     revision,
     snapshot ? JSON.stringify(snapshot) : null,
     JSON.stringify(config),
     accessSnapshot ? JSON.stringify(accessSnapshot) : null,
     opAnalytics ? 1 : 0,
     actor || "owner",
     actorName || null,
     warnings.length ? JSON.stringify(warnings) : null,
     domainPlan ? JSON.stringify(domainPlan) : null,
     keepOff,
     now(),
     now(),
    );
   await this.event();
   return this.operation(id);
  } catch (e) {
   this.recordAuthError(e, c);
   if (undoRow) this.undoPrepareRow(undoRow);
   if (!(e instanceof RemoteError) && /UNIQUE constraint failed/.test(String(e?.message))) {
    throw new RemoteError("Another change to this site or domain is in progress. Finish or cancel it first.", 409);
   }
   throw e;
  }
 }

 undoPrepareRow({ id, row }) {
  if (this.db.prepare("SELECT id FROM operations WHERE publication_id=? LIMIT 1").get(id)) {
   if (!row) return;
  }
  if (!row) {
   this.db.prepare("DELETE FROM publications WHERE id=?").run(id);
   return;
  }
  const cols = Object.keys(row).filter((k) => k !== "id");
  this.db.prepare(`UPDATE publications SET ${cols.map((k) => k + "=?").join(",")} WHERE id=?`).run(...cols.map((k) => row[k]), id);
 }

 operation(id) {
  const op = this.op(id);
  if (!op) throw new RemoteError("The operation was not found.", 404);
  const { access_snapshot, access_config, snapshot, ...visible } = op;
  return {
   ...visible,
   warnings: op.warnings ? JSON.parse(op.warnings) : [],
   confirmation: JSON.parse(op.confirmation),
  };
 }

 async confirm(id, revision) {
  const op = this.op(id);
  if (!op || op.revision !== revision || op.status !== "prepared") throw new RemoteError("The operation changed. Prepare it again.", 409);
  this.set(id, "queued");
  this.launch(id, false);
  return { id, status: "queued" };
 }

 cancel(id) {
  const op = this.op(id);
  if (!op) throw new RemoteError("The operation was not found.", 404);
  if (op.status !== "prepared") throw new RemoteError("This operation may have changed Cloudflare. Check its result first.", 409);
  this.set(id, "cancelled");
  return { cancelled: true };
 }

 reconcile(id) {
  const op = this.op(id);
  if (!op || op.status === "prepared") throw new RemoteError("The operation has not been confirmed.", 409);
  if (["failed", "published", "removed", "renamed", "cancelled"].includes(op.status)) return this.operation(id);
  this.launch(id, true);
  return { id, status: op.status };
 }

 launch(id, recovery) {
  if (this.running.has(id) || this.closing) return;
  this.running.add(id);
  queueMicrotask(() =>
   this.execute(id, recovery)
    .catch(() => {})
    .finally(() => {
     this.running.delete(id);
     const op = this.op(id);
     if (op && !active.includes(op.status)) {
      const p = this.pub(op.publication_id);
      if (p) this.dropBundle(p.artifact_id, op.version);
     }
    }),
  );
 }

 async recover() {
  for (const op of this.db.prepare(`SELECT id FROM operations WHERE status IN (${active.slice(1).map(() => "?").join(",")})`).all(...active.slice(1))) {
   this.launch(op.id, true);
  }
 }

 async checkProject(cf, p) {
  const project = await cf.getProject(p.project);
  if (project && p.identity && identity(project) !== p.identity) {
   throw new RemoteError("The remote project identity changed. Review it in Cloudflare.", 409);
  }
  return project;
 }

 async notifyInboxFYI(p, op, url) {
  if (!op.actor || !op.actor.startsWith("agent:")) return;
  // The host sends no agent name and this extension does not hold agents:read,
  // so the FYI never shows a raw agent id (B6).
  const who = op.actor_name || "An agent";
  let workspaceId = "";
  try {
   const src = await this.source(p.artifact_id);
   workspaceId = src?.artifact?.workspaceId || "";
  } catch {}
  const verb = op.action === "rollback" ? "restored" : "published";
  const accessWord = p.access_mode === "restricted" ? "Restricted" : "Public";
  const host = url ? new URL(url).hostname : `${p.project}.pages.dev`;
  await this.host("/inbox", 64 << 10, {
   title: `${who} ${verb} version ${op.version} of ${p.title}`,
   body: `${host} · ${accessWord}`,
   workspaceId,
  }).catch(() => {});
 }

 async notifyFailureFYI(id, err = null) {
  const op = this.op(id);
  if (op?.actor === "auto" && op.action === "publish") return this.autoFailed(op, err);
  if (!op?.actor?.startsWith("agent:") || !["publish", "rollback"].includes(op.action)) return;
  const p = this.pub(op.publication_id);
  if (!p) return;
  let workspaceId = "";
  try {
   workspaceId = (await this.source(p.artifact_id))?.artifact?.workspaceId || "";
  } catch {}
  const who = op.actor_name || "An agent";
  const verb = op.action === "rollback" ? "restore" : "publish";
  const ending = op.status === "unknown" ? "The result is uncertain; check it in Sites." : "Nothing changed on the live site.";
  await this.host("/inbox", 64 << 10, {
   title: `${who} could not ${verb} version ${op.version} of ${p.title}`,
   body: `${op.error || "Cloudflare did not complete the operation."} ${ending}`.slice(0, 1000),
   workspaceId,
  }).catch(() => {});
 }

 async finish(cf, p, op, deployment) {
  const d = await cf.deployment(p.project, deployment);
  const status = d.latest_stage?.status;
  if (["failure", "failed", "canceled", "cancelled"].includes(status)) {
   this.set(op.id, "failed", { error: "Cloudflare could not publish this version. The previous publication is retained." });
   await this.notifyFailureFYI(op.id);
   return;
  }
  if (status !== "success") {
   this.set(op.id, "verifying", { deployment });
   return;
  }
  const project = await this.checkProject(cf, p);
  if (!project || project.canonical_deployment?.id !== deployment) {
   this.set(op.id, "unknown", { error: "The production publication differs from this operation. Review Cloudflare before continuing." });
   return;
  }
  const config = op.access_config ? JSON.parse(op.access_config) : accessConfig();
  if (config.mode === "restricted") {
   await this.access.verify(this.pub(p.id), config, project, (await cf.deployments(p.project)).map((x) => x.url));
  }
  const url = publicURL("https://" + project.subdomain);
  const snap = op.snapshot ? JSON.parse(op.snapshot) : null;
  const nextUndo = op.action === "rollback" && snap?.previousVersion && snap.previousVersion !== op.version ? snap.previousVersion : null;
  // D4: the keep-off decision taken at prepare (op.keep_off) applies in the
  // same transaction as the new version, so the next round never publishes
  // the latest over a person's or an agent's choice.
  const cur = this.pub(p.id);
  this.db.exec("BEGIN IMMEDIATE");
  try {
   this.db
    .prepare("UPDATE publications SET status='published',version=?,digest=?,deployment=?,url=?,undo_version=? WHERE id=?")
    .run(op.version, op.digest, deployment, url, nextUndo, p.id);
   this.syncBackoff.delete(p.id);
   if (op.keep_off && cur?.keep_updated) this.db.prepare("UPDATE publications SET keep_updated=0,sync_note=?,sync_failed_version=NULL WHERE id=?").run(op.keep_off, p.id);
   // A version at or past the one waiting (by hand or automatically) settles
   // the waiting note and Try again.
   else if (cur?.keep_updated && (op.actor === "auto" || (cur.sync_failed_version && op.version >= cur.sync_failed_version))) this.db.prepare("UPDATE publications SET sync_note=NULL,sync_failed_version=NULL WHERE id=?").run(p.id);
   this.db
    .prepare("INSERT OR REPLACE INTO deployments(id,publication_id,operation_id,version,digest,url,created_at,project,pruned) VALUES(?,?,?,?,?,?,?,?,0)")
    .run(deployment, p.id, op.id, op.version, op.digest, publicURL(d.url), now(), p.project);
   this.db.prepare("UPDATE operations SET status='published',deployment=?,error=NULL,updated_at=? WHERE id=?").run(deployment, now(), op.id);
   this.db.exec("COMMIT");
  } catch (e) {
   this.db.exec("ROLLBACK");
   throw e;
  }
  await this.event();
  await this.notifyInboxFYI(this.pub(p.id), op, url);
 }

 async execute(id, recovery) {
  let op = this.op(id);
  let p = this.pub(op.publication_id);
  const phase = op.remote_phase || op.status;
  let effect = recovery && ["creating", "protecting", "analytics", "dns", "deploying", "verifying", "removing", "rolling-back", "unknown"].includes(op.status);
  let currentConfig = null;
  try {
   currentConfig = await this.configuration();
   const cf = await this.cloud(p);
   let project = await this.checkProject(cf, p);

   if (op.action === "remove") {
    if (!project) {
     if (p.access_app || p.access_attempt) {
      this.set(id, "protecting");
      effect = true;
     }
     await this.access.remove(p, op.access_snapshot ? JSON.parse(op.access_snapshot) : null, recovery);
     await this.analytics.dispose(cf, p);
     // Idempotent: a record Sites created and that still reads as written goes.
     const left = await this.domains.unlinkAll(cf, p);
     this.forgetRemoved(p);
     await this.leftRecords(p, id, left);
     this.set(id, "removed");
     return;
    }
    // A delete that may have happened is never repeated. The DNS step before
    // it (phase "dns") deleted only this site's own records and is safe again.
    if (recovery && (op.status === "removing" || (op.status === "unknown" && phase !== "dns"))) {
     this.set(id, "unknown", { error: "Removal has not been confirmed. Check Cloudflare again; this extension will not repeat an uncertain delete." });
     return;
    }
    const deps = await cf.deployments(p.project);
    const snapshot = { identity: identity(project), domains: [...(project.domains || [])].sort(), deployments: deps.map((d) => d.id).sort() };
    if (JSON.stringify(snapshot) !== op.snapshot) {
     this.set(id, "failed", { error: "The project changed after review. Prepare removal again." });
     return;
    }
    if (op.access_snapshot && accessHash(await this.access.snapshot(p)) !== accessHash(JSON.parse(op.access_snapshot))) {
     throw new RemoteError("The Access policy changed after review.", 409);
    }
    // D6: the CNAME records Sites created go before the project, so no name
    // is left pointing at a pages.dev address another account could claim.
    let leftBehind = [];
    if (this.domains.list(p).some((r) => r.dns_owned)) {
     this.set(id, "dns");
     effect = true;
     leftBehind = await this.domains.unlinkAll(cf, p);
    }
    this.set(id, "removing");
    effect = true;
    // D10: Cloudflare refuses deleting projects with >100 deployments until
    // excess non-production deployments are removed first.
    if (deps.length > 100 && typeof cf.deleteDeployment === "function") {
     const canonicalId = project.canonical_deployment?.id;
     const removable = deps.filter((d) => d.id !== canonicalId).slice(99);
     for (const oldDep of removable) {
      await cf.deleteDeployment(p.project, oldDep.id);
     }
    }
    await cf.remove(p.project);
    if (await cf.getProject(p.project)) {
     this.set(id, "unknown", { error: "Cloudflare still reports this project. Check again." });
     return;
    }
    if (p.access_app || p.access_attempt) this.set(id, "protecting");
    await this.access.remove(p, op.access_snapshot ? JSON.parse(op.access_snapshot) : null, false);
    await this.analytics.dispose(cf, p);
    this.forgetRemoved(p);
    await this.leftRecords(p, id, leftBehind);
    this.set(id, "removed");
    return;
   }

   if (op.action === "keep") {
    if (!project) throw new RemoteError("The project is missing.", 409);
    this.db.prepare("UPDATE publications SET keep_updated=1,sync_note=NULL,sync_failed_version=NULL WHERE id=?").run(p.id);
    this.set(id, "published");
    // Follows at once: a newer version waiting is published now.
    void this.syncRound({ only: p.id });
    return;
   }

   if (op.action === "domain-add") {
    if (!project) throw new RemoteError("The project is missing.", 409);
    if (p.access_mode === "restricted" || p.access_app || p.access_attempt) throw new RemoteError("This site became restricted; custom domains work on public sites.", 409);
    effect = true;
    try {
     await this.domains.add(cf, p, op, (status) => this.set(id, status));
    } catch (e) {
     // A refused add leaves no local row behind and fails, also on Check
     // result (nothing is uncertain any more); a lost answer keeps the row.
     const plan = JSON.parse(op.domain_plan);
     const row = this.domains.row(plan.account, plan.hostname);
     if (e instanceof RemoteError && e.status >= 400 && e.status < 500 && (!row || (row.publication_id === p.id && !row.domain_id))) {
      if (row) this.db.prepare("DELETE FROM publication_domains WHERE id=?").run(row.id);
      this.recordAuthError(e, currentConfig);
      this.set(id, "failed", { error: e.message });
      return;
     }
     throw e;
    }
    this.set(id, "published");
    return;
   }

   if (op.action === "domain-remove") {
    const plan = JSON.parse(op.domain_plan);
    const row = this.domains.row(plan.account, plan.hostname);
    if (row && row.publication_id === p.id) {
     this.set(id, "removing");
     effect = true;
     const { left, message } = await this.domains.remove(cf, p, row);
     if (left) await this.leftRecords(p, id, [message]);
    }
    this.set(id, "removed");
    return;
   }

   if (op.action === "delete-link") {
    if (!project) throw new RemoteError("The project is missing.", 409);
    if (project.canonical_deployment?.id === op.deployment) {
     this.set(id, "failed", { error: "That link now belongs to the live version, so it was not deleted." });
     return;
    }
    this.set(id, "removing");
    effect = true;
    // A deployment id is never reused, so deleting it again after a lost
    // answer cannot touch anything else; absence settles it.
    try {
     await cf.deleteDeployment(p.project, op.deployment);
    } catch (e) {
     if (!(e instanceof RemoteError && e.status === 404)) throw e;
    }
    let still = null;
    try {
     still = await cf.deployment(p.project, op.deployment);
    } catch (e) {
     if (!(e instanceof RemoteError && e.status === 404)) throw e;
    }
    if (still) {
     this.set(id, "unknown", { error: "Cloudflare still lists this link. Check again." });
     return;
    }
    this.db.prepare("UPDATE deployments SET pruned=1,link_deleted=1 WHERE id=? AND publication_id=?").run(op.deployment, p.id);
    this.set(id, "removed");
    return;
   }

   if (op.action === "access") {
    if (!project) throw new RemoteError("The project is missing.", 409);
    const reviewed = JSON.parse(op.snapshot);
    if (project.canonical_deployment?.id !== reviewed.canonical || JSON.stringify([...(project.domains || [])].sort()) !== JSON.stringify(reviewed.domains || [])) {
     throw new RemoteError("The production version changed after review.", 409);
    }
    this.set(id, "protecting");
    effect = true;
    await this.finishAccess(p, op, project, recovery);
    if (JSON.parse(op.access_config).mode === "restricted") {
     await this.access.verify(this.pub(p.id), JSON.parse(op.access_config), project, (await cf.deployments(p.project)).map((d) => d.url));
    }
    this.set(id, "published");
    return;
   }

   if (op.action === "rollback") {
    if (!project) throw new RemoteError("The remote project is missing.", 409);
    const snapshot = JSON.parse(op.snapshot || "{}");
    const needsReupload = Boolean(snapshot.reupload || !op.deployment);
    if (!needsReupload) {
     if (recovery) {
      await this.finish(cf, p, op, op.deployment);
      return;
     }
     if (project.canonical_deployment?.id !== snapshot.canonical) {
      this.set(id, "failed", { error: "The production version changed after review. Prepare restore again." });
      return;
     }
     if (p.access_mode === "restricted") {
      await this.access.verify(p, accessConfig({ mode: p.access_mode, emails: JSON.parse(p.access_emails) }), project);
     }
     try {
      this.set(id, "rolling-back");
      effect = true;
      await cf.rollback(p.project, op.deployment);
      await this.finish(cf, p, op, op.deployment);
      return;
     } catch (e) {
      if (!(e instanceof RemoteError && e.status === 404)) throw e;
      this.db.prepare("UPDATE deployments SET pruned=1 WHERE id=?").run(op.deployment);
     }
    }
    // D10 Re-upload fallback when Cloudflare pruned the deployment (>30 days / >100 deploys).
    if (recovery && ["deploying", "verifying", "unknown"].includes(phase)) {
     if (op.deployment && needsReupload) {
      await this.finish(cf, p, op, op.deployment);
      return;
     }
     const found = (await cf.deployments(p.project)).filter((d) => d.deployment_trigger?.metadata?.commit_message === `picode:${id}:${op.digest}`);
     if (found.length === 1) {
      this.set(id, "verifying", { deployment: found[0].id });
      await this.finish(cf, p, op, found[0].id);
      return;
     }
     this.set(id, "unknown", { error: "The restored deployment result is uncertain. Check again; no second deployment was created." });
     return;
    }
    if (project.canonical_deployment?.id !== snapshot.canonical) {
     this.set(id, "failed", { error: "The production version changed after review. Prepare restore again." });
     return;
    }
    if (p.access_mode === "restricted") {
     await this.access.verify(p, accessConfig({ mode: p.access_mode, emails: JSON.parse(p.access_emails) }), project);
    }
    const localBundle = await this.bundle(p.artifact_id, op.version);
    if (op.digest && localBundle.digest !== op.digest) {
     throw new RemoteError("The local artifact version changed after review.", 409);
    }
    this.set(id, "uploading");
    effect = false;
    let uploaded = 0;
    const total = localBundle.files.length;
    const onUpload = () => {
     uploaded++;
     this.db.prepare("UPDATE operations SET progress=? WHERE id=?").run(JSON.stringify({ uploaded, total }), id);
     void this.event();
    };
    const form = await cf.deploy(p.project, localBundle, `picode:${id}:${op.digest}`, onUpload);
    this.set(id, "deploying");
    effect = true;
    const created = await cf.createDeployment(p.project, form);
    if (!created?.id) throw new RemoteError("Cloudflare did not identify the restored deployment.");
    this.set(id, "verifying", { deployment: created.id });
    op = this.op(id);
    await this.finish(cf, p, op, created.id);
    return;
   }

   if (op.action === "analytics") {
    if (!project) throw new RemoteError("The project is missing.", 409);
    const reviewed = JSON.parse(op.snapshot);
    if (project.canonical_deployment?.id !== reviewed.canonical || JSON.stringify([...(project.domains || [])].sort()) !== JSON.stringify(reviewed.domains || [])) {
     throw new RemoteError("The production version changed after review.", 409);
    }
    this.set(id, "analytics");
    effect = true;
    if (op.analytics) await this.analytics.ensure(cf, this.pub(p.id), project);
    else await this.analytics.clear(cf, this.pub(p.id), project);
    this.set(id, "published");
    return;
   }

   if (op.action === "rename") {
    const reviewed = JSON.parse(op.snapshot);
    const progress0 = op.progress ? JSON.parse(op.progress) : null;
    if (progress0?.swapped) {
     /* The new address is confirmed; only the old project teardown remains. */
    } else {
     if (!project) throw new RemoteError("The remote project is missing.", 409);
     if (project.canonical_deployment?.id !== reviewed.canonical) throw new RemoteError("The production version changed after review. Prepare the address change again.", 409);
     if (op.deployment) {
      if (!(await this.finishRename(cf, p, op, op.deployment))) return;
     } else if (phase === "deploying") {
      const found = (await cf.deployments(reviewed.newName)).filter((d) => d.deployment_trigger?.metadata?.commit_message === `picode:${id}:${op.digest}`);
      if (found.length === 1) {
       this.set(id, "verifying", { deployment: found[0].id });
       op = this.op(id);
       if (!(await this.finishRename(cf, p, op, found[0].id))) return;
      } else {
       this.set(id, "unknown", { error: "The new deployment result is uncertain. Check again; no second deployment was created." });
       return;
      }
     } else {
      let fresh = null;
      if (["creating", "analytics", "uploading", "deploying"].includes(phase)) {
       fresh = await cf.getProject(reviewed.newName);
       if (fresh && (Date.parse(fresh.created_on) < Date.parse(op.created_at) - 5000 || fresh.source || fresh.production_branch !== "main")) {
        throw new RemoteError("The new project could not be identified as this operation's project.", 409);
       }
      }
      if (!fresh) {
       if (await cf.getProject(reviewed.newName)) throw new RemoteError("The new project name is already in use. Prepare the address change with another name.", 409);
       this.set(id, "creating");
       effect = true;
       fresh = await cf.createProject(reviewed.newName);
      }
      if (!fresh?.id || !fresh.created_on) throw new RemoteError("Cloudflare did not return the new project's identity.");
      this.set(id, "analytics");
      effect = true;
      const newTag = await this.analytics.ensure(cf, { ...p, project: reviewed.newName }, fresh, false);
      this.db
       .prepare("UPDATE operations SET progress=? WHERE id=?")
       .run(JSON.stringify({ oldName: p.project, newName: reviewed.newName, newIdentity: identity(fresh), newTag, oldTag: reviewed.oldTag || null }), id);
      op = this.op(id);
      this.set(id, "uploading");
      effect = false;
      const renameBundle = await this.bundle(p.artifact_id, op.version);
      if (renameBundle.digest !== op.digest) throw new RemoteError("The prepared package changed. Prepare the address change again.", 409);
      const form = await cf.deploy(
       reviewed.newName,
       renameBundle,
       `picode:${id}:${op.digest}`,
       (() => {
        let n = 0;
        const total = renameBundle.files.length;
        return () => {
         n++;
         this.db.prepare("UPDATE operations SET progress=? WHERE id=?").run(JSON.stringify({ uploaded: n, total }), id);
         void this.event();
        };
       })(),
      );
      const current = await this.checkProject(cf, p);
      if (current?.canonical_deployment?.id !== reviewed.canonical) throw new RemoteError("The production version changed after review. Prepare the address change again.", 409);
      this.set(id, "deploying");
      effect = true;
      const d = await cf.createDeployment(reviewed.newName, form);
      if (!d?.id) throw new RemoteError("Cloudflare did not identify the new deployment.");
      this.set(id, "verifying", { deployment: d.id });
      op = this.op(id);
      if (!(await this.finishRename(cf, p, op, d.id))) return;
     }
    }
    const swappedBefore = !!progress0?.swapped;
    const progress = JSON.parse(this.op(id).progress || "null");
    if (!progress?.newName || !progress?.swapped) throw new RemoteError("The address change is not confirmed. Check the result.", 409);
    this.set(id, "removing");
    effect = true;
    if (await cf.getProject(progress.oldName)) {
     if (recovery && swappedBefore) {
      this.set(id, "unknown", { error: "The old site has not been confirmed removed. Check Cloudflare again; this extension will not repeat an uncertain delete." });
      return;
     }
     await cf.remove(progress.oldName);
     if (await cf.getProject(progress.oldName)) {
      this.set(id, "unknown", { error: "Cloudflare still reports the old project. Check again." });
      return;
     }
    }
    if (progress.oldTag && progress.oldTag !== this.pub(p.id).analytics_tag) await this.analytics.dispose(cf, { ...p, analytics_tag: progress.oldTag });
    this.set(id, "renamed");
    return;
   }

   if (recovery && ["deploying", "verifying", "unknown"].includes(phase) && p.identity) {
    if (op.deployment) {
     await this.finish(cf, p, op, op.deployment);
     return;
    }
    const found = (await cf.deployments(p.project)).filter((d) => d.deployment_trigger?.metadata?.commit_message === `picode:${id}:${op.digest}`);
    if (found.length === 1) {
     this.set(id, "verifying", { deployment: found[0].id });
     await this.finish(cf, p, op, found[0].id);
     return;
    }
    this.set(id, "unknown", { error: "The deployment result is uncertain. Check again; no second deployment was created." });
    return;
   }

   const publishBundle = await this.bundle(p.artifact_id, op.version);
   if (publishBundle.digest !== op.digest) throw new RemoteError("The prepared package changed. Prepare publication again.", 409);
   if (!p.identity) {
    if (recovery && phase === "creating") {
     if (!p.generated_name) {
      this.set(id, "unknown", { error: "Project creation for a chosen name cannot be identified after interruption. Review Cloudflare; no project was adopted or created again." });
      return;
     }
     if (!project) {
      this.set(id, "unknown", { error: "Project creation is uncertain. Check Cloudflare again before retrying." });
      return;
     }
     if (Date.parse(project.created_on) < Date.parse(op.created_at) - 5000 || project.source || project.production_branch !== "main") {
      throw new RemoteError("The project could not be identified as this operation's project.", 409);
     }
    } else {
     if (project) throw new RemoteError("The project name is already in use.", 409);
     this.set(id, "creating");
     effect = true;
     project = await cf.createProject(p.project);
    }
    if (!project?.id || !project.created_on) throw new RemoteError("Cloudflare did not return the project's identity.");
    this.db.prepare("UPDATE publications SET identity=? WHERE id=?").run(identity(project), p.id);
    p = this.pub(p.id);
   } else if (!project) {
    throw new RemoteError("The remote project is missing.", 409);
   }

   if (op.snapshot) {
    const reviewed = JSON.parse(op.snapshot);
    if (project.canonical_deployment?.id !== reviewed.canonical || (reviewed.domains && JSON.stringify([...(project.domains || [])].sort()) !== JSON.stringify(reviewed.domains))) {
     throw new RemoteError("The project changed after review. Prepare publication again.", 409);
    }
   }

   const config = op.access_config ? JSON.parse(op.access_config) : accessConfig();
   if (config.mode === "restricted" || p.access_app || p.access_attempt) {
    this.set(id, "protecting");
    effect = true;
    await this.finishAccess(p, op, project, recovery);
    p = this.pub(p.id);
   }
   if (op.analytics) {
    this.set(id, "analytics");
    effect = true;
    await this.analytics.ensure(cf, p, project);
    p = this.pub(p.id);
   } else if (p.analytics_tag) {
    this.set(id, "analytics");
    effect = true;
    await this.analytics.clear(cf, p, project);
    p = this.pub(p.id);
   }

   this.set(id, "uploading");
   effect = false;
   let uploaded = 0;
   const total = publishBundle.files.length;
   const onUpload = () => {
    uploaded++;
    this.db.prepare("UPDATE operations SET progress=? WHERE id=?").run(JSON.stringify({ uploaded, total }), id);
    void this.event();
   };
   const form = await cf.deploy(p.project, publishBundle, `picode:${id}:${op.digest}`, onUpload);
   if (op.snapshot) {
    const reviewed = JSON.parse(op.snapshot);
    const current = await this.checkProject(cf, p);
    if (current?.canonical_deployment?.id !== reviewed.canonical) throw new RemoteError("The production version changed after review. Prepare publication again.", 409);
   }
   this.set(id, "deploying");
   effect = true;
   const d = await cf.createDeployment(p.project, form);
   if (!d?.id) throw new RemoteError("Cloudflare did not identify the deployment.");
   this.set(id, "verifying", { deployment: d.id });
   op = this.op(id);
   await this.finish(cf, p, op, d.id);
  } catch (e) {
   this.recordAuthError(e, currentConfig);
   this.set(
    id,
    effect && (recovery || !(e instanceof RemoteError && [400, 401, 403, 404, 409, 422].includes(e.status) && this.op(id).remote_phase !== "protecting")) ? "unknown" : "failed",
    { error: e instanceof RemoteError ? e.message : "The operation could not complete. Check its result." },
   );
   await this.notifyFailureFYI(id, e);
  }
 }

 async tick() {
  if (this.closing) return;
  for (const op of this.db.prepare("SELECT id FROM operations WHERE status='verifying'").all()) {
   this.launch(op.id, true);
  }
  void this.background();
 }

 // D6: records Sites created but could not delete (the token lost its DNS
 // permission). The operation carries them as warnings and one Inbox note
 // tells the person, so no name is left pointing at a removed address unseen.
 async leftRecords(p, opId, messages) {
  if (!messages?.length) return;
  this.db.prepare("UPDATE operations SET warnings=? WHERE id=?").run(JSON.stringify(messages.map((message) => ({ message }))), opId);
  await this.fyi(p, `Delete ${messages.length === 1 ? "a DNS record" : "DNS records"} left by ${p.title}`, messages.join(" "));
 }

 forgetRemoved(p) {
  this.db.prepare("UPDATE publications SET status='removed',undo_version=NULL,keep_updated=0,sync_note=NULL,sync_failed_version=NULL WHERE id=?").run(p.id);
  this.db.prepare("UPDATE deployments SET pruned=1 WHERE publication_id=?").run(p.id);
  this.domains.forget(p);
  this.visits.forget(p);
 }

 // The background round: Keep up to date, domains waiting for DNS, visits.
 // Once a minute from tick(); the page may nudge it (Sites open, an artifact
 // changed) at most every 15 seconds.
 async background({ force = false } = {}) {
  if (this.closing || this.backgroundRunning) return;
  const t = Date.now();
  if (!force && t - this.backgroundAt < BACKGROUND_MS) return;
  this.backgroundAt = t;
  this.backgroundRunning = true;
  try {
   await this.syncRound();
   await this.refreshDomains().catch(() => {});
   await this.refreshVisits().catch(() => {});
  } finally {
   this.backgroundRunning = false;
  }
 }
 nudge() {
  const t = Date.now();
  if (t - (this.nudgedAt || 0) < NUDGE_MS) return { queued: false };
  this.nudgedAt = t;
  void this.background({ force: true });
  return { queued: true };
 }

 async readyConfiguration() {
  const c = await this.configuration();
  if (!c.account || !c.token) return null;
  return (await this.connectionState()).status === "ready" ? c : null;
 }

 // D4 Keep up to date. This process runs on one of the person's synced
 // computers at a time (outsideEffects: true), so two computers never both
 // follow a site. A computer whose records are stale (Cloudflare's production
 // deployment is not the one recorded here: another computer, the dashboard
 // or a restore elsewhere published since) turns Keep up to date off instead
 // of publishing over that work. One active operation per site and the
 // deployment marker keep a single computer from publishing twice.
 syncRound({ only = null } = {}) {
  if (this.syncing) return this.syncing;
  const run = (async () => {
   await null;
   try {
    await this.syncAll(only);
   } catch {}
  })();
  this.syncing = run;
  run.finally(() => {
   if (this.syncing === run) this.syncing = null;
  });
  return run;
 }

 async syncAll(only) {
  if (this.closing) return;
  // A refused or unchecked token pauses every automatic publish; the
  // connection banner says what to do, and the next round resumes. A site
  // with a version waiting says why, once.
  const c = await this.readyConfiguration();
  if (!c) {
   const cur = await this.configuration();
   if (cur.account && cur.token && (await this.connectionState()).expired) await this.syncHoldAll(cur.account, (v) => `Version ${v} waits: Cloudflare refused the API token. Paste a new token in Settings to resume.`);
   return;
  }
  const rows = this.db
   .prepare(`SELECT id FROM publications WHERE keep_updated=1 AND status='published' AND account_id=?${only ? " AND id=?" : ""}`)
   .all(...(only ? [c.account, only] : [c.account]));
  if (!rows.length) return;
  const artifacts = (await this.host("/artifacts")).artifacts || [];
  for (const r of rows) {
   if (this.closing) return;
   try {
    await this.syncSite(this.pub(r.id), artifacts, c);
   } catch {}
  }
 }

 async syncHoldAll(account, note) {
  const rows = this.db.prepare("SELECT id FROM publications WHERE keep_updated=1 AND status='published' AND account_id=?").all(account);
  if (!rows.length) return;
  const artifacts = (await this.host("/artifacts")).artifacts || [];
  for (const r of rows) {
   const p = this.pub(r.id);
   const latest = Number(artifacts.find((a) => a.id === p.artifact_id)?.liveVersion) || 0;
   if (latest && p.version && latest > p.version) await this.syncHold(p, note(latest));
  }
 }

 async syncSite(p, artifacts, c) {
  if (!p?.keep_updated || p.status !== "published" || p.account_id !== c.account) return;
  const art = artifacts.find((a) => a.id === p.artifact_id);
  const latest = Number(art?.liveVersion) || 0;
  if (!latest || !p.version) return;
  if (latest <= p.version) {
   // Up to date (by hand or not): a waiting note or Try again is stale.
   if (p.sync_note || p.sync_failed_version) {
    this.db.prepare("UPDATE publications SET sync_note=NULL,sync_failed_version=NULL WHERE id=? AND keep_updated=1").run(p.id);
    await this.event();
   }
   return;
  }
  if (p.sync_failed_version === latest) return;
  const wait = this.syncBackoff.get(p.id);
  if (wait && wait.version === latest && Date.now() < wait.until) return;
  if (this.activeOp(p.id)) return;
  if (p.access_mode === "restricted") {
   const setup = (await this.accessSetupState()).status;
   // Not checked yet (just after a restart): wait quietly for the check.
   if (setup === "unchecked") return;
   if (setup !== "ready") return this.syncHold(p, `Version ${latest} waits: restricted access needs setup in Settings before it can be published automatically.`);
  }
  const cf = this.remote(c.account, c.token);
  let project;
  try {
   project = await this.checkProject(cf, p);
  } catch (e) {
   if (e instanceof RemoteError && e.status === 409) return this.syncStop(p, "Keep up to date turned off: the site's Cloudflare project changed identity. Review it in Cloudflare.");
   throw e;
  }
  if (!project) return this.syncStop(p, "Keep up to date turned off: the site's project is missing on Cloudflare.");
  if (project.canonical_deployment?.id !== p.deployment) {
   return this.syncStop(p, "Keep up to date turned off: Cloudflare shows a version this computer did not publish (another computer, the dashboard or a restore elsewhere). Review the site, then turn it on again.");
  }
  let prepared;
  try {
   prepared = await this.prepare({ action: "publish", artifactId: p.artifact_id, version: latest, actor: "auto", actorName: "Keep up to date" });
  } catch (e) {
   // Token refused, Cloudflare busy or unreachable, or the owner started a
   // change meanwhile: the next round retries. Only a definite refusal of
   // this version is recorded.
   if (!definiteRefusal(e) || this.activeOp(p.id)) return;
   return this.syncFailed(p, latest, e.message);
  }
  if (prepared.unchanged) return;
  // Turned off (or the site changed) while this round prepared: never publish.
  const now2 = this.pub(p.id);
  if (!now2?.keep_updated || now2.status !== "published" || now2.deployment !== p.deployment) {
   this.cancel(prepared.id);
   return;
  }
  await this.confirm(prepared.id, prepared.revision);
 }

 activeDomainOp(account, hostname) {
  return (
   this.db
    .prepare(
     `SELECT id FROM operations WHERE action IN ('domain-add','domain-remove') AND status IN (${active.map(() => "?").join(",")}) AND json_extract(domain_plan,'$.account')=? AND json_extract(domain_plan,'$.hostname')=?`,
    )
    .get(...active, account, hostname) || null
  );
 }

 activeOp(publicationId) {
  return this.db.prepare(`SELECT id FROM operations WHERE publication_id=? AND status IN (${active.map(() => "?").join(",")})`).get(publicationId, ...active) || null;
 }

 async fyi(p, title, body) {
  let workspaceId = "";
  try {
   workspaceId = (await this.source(p.artifact_id))?.artifact?.workspaceId || "";
  } catch {}
  await this.host("/inbox", 64 << 10, { title: title.slice(0, 200), body: body.slice(0, 1000), workspaceId }).catch(() => {});
 }

 // One note per distinct reason: a hold repeated every minute stays quiet.
 async syncHold(p, note) {
  if (p.sync_note === note) return;
  this.db.prepare("UPDATE publications SET sync_note=? WHERE id=?").run(note, p.id);
  await this.event();
  await this.fyi(p, `Keep up to date is waiting for ${p.title}`, note);
 }
 async syncStop(p, note) {
  this.db.prepare("UPDATE publications SET keep_updated=0,sync_note=?,sync_failed_version=NULL WHERE id=?").run(note, p.id);
  await this.event();
  await this.fyi(p, `Keep up to date turned off for ${p.title}`, note);
 }
 async syncFailed(p, version, message) {
  this.db.prepare("UPDATE publications SET sync_failed_version=?,sync_note=? WHERE id=?").run(version, `Version ${version} was not published automatically. ${message}`, p.id);
  await this.event();
  await this.fyi(p, `Keep up to date could not publish version ${version} of ${p.title}`, `${message} The site keeps version ${p.version}.`);
 }
 // An automatic publish that Cloudflare refused: that version is not tried
 // again on its own (a newer version or Try again does). An uncertain one
 // holds at Check result, which blocks every later round for the site.
 async autoFailed(op, err = null) {
  const p = this.pub(op.publication_id);
  if (!p) return;
  if (op.status === "unknown") {
   await this.fyi(p, `Keep up to date could not confirm version ${op.version} of ${p.title}`, `${op.error || "Cloudflare did not confirm the publication."} The result is uncertain; check it in Sites.`);
   return;
  }
  // A dropped connection, a busy or failing Cloudflare, or a refused token is
  // not this version's fault: the next round tries again (a refused token
  // pauses every round until it is replaced). Cloudflare's own deployment
  // failure (no err) and a 4xx refusal are definite.
  if (err && !definiteRefusal(err)) {
   // The first retry is the next round; repeated failures wait 2, 4 … 60 minutes.
   const prev = this.syncBackoff.get(p.id);
   const attempts = prev?.version === op.version ? prev.attempts + 1 : 1;
   const minutes = attempts <= 1 ? 0 : Math.min(60, 2 ** (attempts - 1));
   this.syncBackoff.set(p.id, { version: op.version, attempts, until: Date.now() + minutes * 60_000 });
   await this.syncHold(p, `Version ${op.version} could not be published just now (${op.error || "Cloudflare did not answer"}); Sites tries again shortly.`);
   return;
  }
  await this.syncFailed(p, op.version, op.error || "Cloudflare did not complete the publication.");
 }

 async setKeep(id, on) {
  const p = this.pub(id);
  if (!p) throw new RemoteError("The publication was not found.", 404);
  if (on) throw new RemoteError("Turn Keep up to date on through its confirmation.", 400);
  this.db.prepare("UPDATE publications SET keep_updated=0,sync_note=NULL,sync_failed_version=NULL WHERE id=?").run(p.id);
  await this.event();
  return { keepUpdated: false };
 }
 // Try again after a refused automatic publish of the same version.
 async retrySync(id) {
  const p = this.pub(id);
  if (!p || !p.keep_updated) throw new RemoteError("Keep up to date is off for this site.", 409);
  this.db.prepare("UPDATE publications SET sync_failed_version=NULL,sync_note=NULL WHERE id=?").run(p.id);
  await this.event();
  await this.syncRound({ only: p.id });
  return { retried: true };
 }

 // D6: domains waiting for DNS or a certificate are read once a minute, ten at a time.
 async refreshDomains() {
  const c = await this.readyConfiguration();
  if (!c) return;
  const rows = this.db
   .prepare("SELECT d.* FROM publication_domains d JOIN publications p ON p.id=d.publication_id WHERE d.account_id=? AND p.account_id=? AND p.status='published' AND d.status IN ('initializing','pending') ORDER BY d.checked_at LIMIT 10")
   .all(c.account, c.account);
  if (!rows.length) return;
  const cf = this.remote(c.account, c.token);
  let changed = false;
  for (const row of rows) {
   if (this.closing) return;
   try {
    await this.domains.refresh(cf, this.pub(row.publication_id), row);
    if (this.domains.row(row.account_id, row.hostname)?.status !== row.status) changed = true;
   } catch (e) {
    this.recordAuthError(e, c);
   }
  }
  if (changed) await this.event();
 }
 // Check now: reads the domain, and asks Cloudflare to validate again when it failed.
 async checkDomain(publicationId, hostname) {
  const p = this.pub(publicationId);
  if (!p) throw new RemoteError("The publication was not found.", 404);
  const row = this.domains.row(p.account_id, normalizeHostname(hostname));
  if (!row || row.publication_id !== p.id) throw new RemoteError("This domain is not on this site.", 404);
  const cf = await this.cloud(p);
  try {
   await this.domains.refresh(cf, p, row, true);
  } catch (e) {
   this.recordAuthError(e, await this.configuration());
   throw e;
  }
  await this.event();
  return this.domains.serialize(p, this.domains.row(row.account_id, row.hostname));
 }

 // D5: cached visits; refreshed when stale (30 minutes) or by Refresh (once a minute).
 async refreshVisits({ manual = false } = {}) {
  const c = await this.configuration();
  const fp = digest(c);
  if (!c.account || !c.token || (await this.connectionState()).status !== "ready") return this.visits.summary(fp);
  if (!manual && !this.visits.stale(c.account, fp)) return this.visits.summary(fp);
  const asked = this.visits.lastQueryAt;
  await this.visits.refresh(this.remote(c.account, c.token), c.account, fp);
  // New numbers or a new status: the page reloads its state.
  if (this.visits.lastQueryAt !== asked) await this.event();
  return this.visits.summary(fp);
 }

 async finishRename(cf, p, op, deployment) {
  const progress = op.progress ? JSON.parse(op.progress) : null;
  if (!progress?.newName || !progress.newIdentity) throw new RemoteError("The address change lost its progress record. Check the result.", 409);
  const d = await cf.deployment(progress.newName, deployment);
  const status = d.latest_stage?.status;
  if (["failure", "failed", "canceled", "cancelled"].includes(status)) {
   this.set(op.id, "failed", { error: "Cloudflare could not publish to the new address. The current site is unchanged." });
   return false;
  }
  if (status !== "success") {
   this.set(op.id, "verifying", { deployment });
   return false;
  }
  const fresh = await cf.getProject(progress.newName);
  if (!fresh || identity(fresh) !== progress.newIdentity || fresh.canonical_deployment?.id !== deployment) {
   this.set(op.id, "unknown", { error: "The new address does not show this publication. Review Cloudflare before continuing." });
   return false;
  }
  if (this.pub(p.id).project !== progress.newName) {
   this.db.exec("BEGIN IMMEDIATE");
   try {
    this.db
     .prepare("UPDATE publications SET project=?,identity=?,deployment=?,url=?,analytics_tag=? WHERE id=?")
     .run(progress.newName, progress.newIdentity, deployment, publicURL("https://" + fresh.subdomain), progress.newTag || p.analytics_tag, p.id);
    this.db
     .prepare("INSERT OR REPLACE INTO deployments(id,publication_id,operation_id,version,digest,url,created_at,project,pruned) VALUES(?,?,?,?,?,?,?,?,0)")
     .run(deployment, p.id, op.id, op.version, op.digest, publicURL(d.url), now(), progress.newName);
    this.db.prepare("UPDATE operations SET progress=?,deployment=?,error=NULL,updated_at=? WHERE id=?").run(JSON.stringify({ ...progress, swapped: true }), deployment, now(), op.id);
    this.db.exec("COMMIT");
   } catch (e) {
    this.db.exec("ROLLBACK");
    throw e;
   }
  }
  await this.event();
  return true;
 }

 async waitForOperation(opId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
   const op = this.op(opId);
   if (!op || ["published", "failed", "unknown", "cancelled", "removed", "renamed"].includes(op.status)) return op;
   await new Promise((r) => setTimeout(r, 25));
  }
  return this.op(opId);
 }

 // Agent capability group `pages` (D3, ADR-0240 + ADR-0237):
 // sites, publish, status, restore. Remove site, making a restricted site
 // public, and changing an existing site's address stay human-only.
 async runTool(req) {
  const failTool = (text) => ({ content: [{ type: "text", text }], isError: true });
  const okTool = (text, structuredContent) => ({ content: [{ type: "text", text }], structuredContent });
  if (req?.protocol !== "picode-tools/1" || req.capability !== "pages") {
   return failTool("Unknown capability.");
  }
  const args = req.arguments || {};
  const agentId = req.context?.agent || "agent";
  const actor = `agent:${agentId}`;
  // The extension is instance-wide, so the host lets it read every
  // workspace's artifacts. An agent only sees and changes sites whose artifact
  // is in its own workspace (free agents: artifacts with no workspace) (B1).
  const agentWorkspace = String(req.context?.workspace || "");
  const inScope = (artifact) => Boolean(artifact) && String(artifact.workspaceId || "") === agentWorkspace;
  const NOT_HERE = (id) => `Artifact ${id} is not available in this agent's workspace.`;
  const scopedSource = async (id) => {
   let src;
   try {
    src = await this.source(id);
   } catch (e) {
    if (e instanceof RemoteError && e.status === 404) return null;
    throw e;
   }
   return inScope(src?.artifact) ? src : null;
  };

  try {
   if (req.tool === "sites") {
    const st = await this.state();
    const filter = args.filter || "all";
    const here = new Set(st.artifacts.filter(inScope).map((a) => a.id));
    const list = st.publications
     .filter((p) => !p.otherAccount && here.has(p.artifact_id))
     .filter((p) => {
      if (filter === "removed") return p.status === "removed";
      if (p.status === "removed") return false;
      if (filter === "update") return p.siteStatus === "update";
      if (filter === "attention") return p.siteStatus === "attention";
      if (filter === "private") return p.access_mode === "restricted";
      return true;
     })
     .slice(0, 50)
     .map((p) => ({
      artifact: p.artifact_id,
      title: p.title,
      url: p.url || `https://${p.project}.pages.dev/`,
      status: p.siteStatus,
      liveVersion: p.version || null,
      latestVersion: p.latestVersion || null,
      access: p.access_mode,
     }));
    const lines = list.length
     ? list.map((s) => `${s.artifact} [${s.status}] v${s.liveVersion ?? "-"} ${s.url} (${s.access})`).join("\n")
     : "No published sites.";
    return okTool(lines, { sites: list });
   }

   if (req.tool === "status") {
    if (args.operation) {
     const op = this.op(String(args.operation));
     const p = op ? this.pub(op.publication_id) : null;
     if (!op || !p || !(await scopedSource(p.artifact_id))) return failTool("The operation was not found.");
     const out = {
      operation: { id: op.id, action: op.action, status: op.status, version: op.version, error: op.error || null },
      artifact: p?.artifact_id || null,
      url: p?.url || null,
      liveVersion: p?.version || null,
     };
     return okTool(`Operation ${op.id}: ${op.status}${op.error ? " — " + op.error : ""}`, out);
    }
    if (!args.artifact) return failTool("Provide artifact or operation.");
    if (!(await scopedSource(String(args.artifact)))) return failTool(NOT_HERE(args.artifact));
    const st = await this.state();
    const pub = st.publications.find((x) => x.artifact_id === args.artifact);
    if (!pub) return okTool(`Artifact ${args.artifact} is not published.`, { artifact: args.artifact, status: "unpublished" });
    const latestOp = pub.operations[0] || null;
    const out = {
     artifact: pub.artifact_id,
     title: pub.title,
     status: pub.siteStatus,
     url: pub.url || null,
     liveVersion: pub.version || null,
     latestVersion: pub.latestVersion || null,
     access: pub.access_mode,
     keepUpToDate: pub.keepUpdated,
     customDomains: pub.domains.filter((d) => d.state === "active").map((d) => d.url),
     otherAccount: pub.otherAccount || undefined,
     operation: latestOp ? { id: latestOp.id, action: latestOp.action, status: latestOp.status, version: latestOp.version, error: latestOp.error || null } : null,
    };
    return okTool(`${pub.title}: ${pub.siteStatus}${pub.url ? " at " + pub.url : ""}`, out);
   }

   if (req.tool === "publish") {
    const artifactId = String(args.artifact || "").trim();
    if (!artifactId) return failTool("artifact is required.");
    const src = await scopedSource(artifactId);
    if (!src) return failTool(NOT_HERE(artifactId));
    const existing = this.db.prepare("SELECT * FROM publications WHERE artifact_id=?").get(artifactId);
    const live = existing && existing.status !== "removed" ? existing : null;
    // D3 human-only boundaries, and B2: on an existing site an agent keeps
    // its access and reader list; a new version is published to the same
    // readers. Choosing who can read an existing site is the owner's, in Sites.
    let desiredAccess;
    if (live) {
     const readers = JSON.parse(live.access_emails || "[]");
     if (live.access_mode === "restricted" && args.access === "public") {
      return failTool("Making a restricted site public requires the owner in Sites; agents keep the site's access and readers.");
     }
     if (args.access !== undefined && args.access !== live.access_mode) {
      return failTool("Changing who can open an existing site requires the owner in Sites; agents keep the site's access and readers.");
     }
     if (args.emails !== undefined) {
      const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
      const asked = args.emails.map((e) => String(e).trim().toLowerCase());
      if (!same(asked, readers.map((e) => String(e).toLowerCase()))) {
       return failTool("Changing an existing site's readers requires the owner in Sites; agents keep the site's access and readers.");
      }
     }
     if (args.projectName && args.projectName !== live.project && live.identity) {
      return failTool("Changing an existing site's address requires the owner in Sites.");
     }
    } else if (args.access !== undefined || args.emails !== undefined) {
     desiredAccess = { mode: args.access || "public", emails: args.emails || [] };
    }
    const targetVersion = Number.isInteger(args.version) && args.version >= 1 ? args.version : src?.artifact?.liveVersion;
    if (!targetVersion) return failTool("Artifact has no live version to publish.");
    const keptBefore = Boolean(live?.keep_updated);
    const prepared = await this.prepare({
     action: "publish",
     artifactId,
     version: targetVersion,
     projectName: args.projectName,
     access: desiredAccess,
     analytics: args.analytics,
     actor,
     actorName: "",
    });
    // D11: key-format warnings for every site, public or restricted (B8).
    const warnMessages = (prepared.warnings || []).map((w) => w.message);
    if (prepared.unchanged) {
     const pub = this.pub(prepared.publication.id);
     const out = {
      status: "live",
      unchanged: true,
      version: pub.version,
      url: pub.url,
      access: pub.access_mode,
      ...(warnMessages.length ? { warnings: warnMessages } : {}),
     };
     return okTool(`Version ${pub.version} is already live at ${pub.url}`, out);
    }
    await this.confirm(prepared.id, prepared.revision);
    const settled = await this.waitForOperation(prepared.id);
    const pub = this.pub(prepared.publication_id);
    if (settled.status === "failed" || settled.status === "unknown") {
     return failTool(settled.error || `Publish ended in state ${settled.status}.`);
    }
    const statusWord = settled.status === "published" ? "live" : settled.status;
    const keepTurnedOff = keptBefore && !pub.keep_updated;
    const out = {
     status: statusWord,
     version: targetVersion,
     url: pub.url || `https://${pub.project}.pages.dev/`,
     access: pub.access_mode,
     operationId: settled.id,
     ...(warnMessages.length ? { warnings: warnMessages } : {}),
     ...(keepTurnedOff ? { keepUpToDate: false } : {}),
    };
    const warnSuffix = warnMessages.length ? ` (${warnMessages.join("; ")})` : "";
    const keepSuffix = keepTurnedOff ? ". Keep up to date was turned off, so the site stays on this older version." : "";
    return okTool(`${statusWord === "live" ? "Published" : "Publishing"} v${targetVersion} at ${out.url}${warnSuffix}${keepSuffix}`, out);
   }

   if (req.tool === "restore") {
    const artifactId = String(args.artifact || "").trim();
    const targetVersion = Number(args.version);
    if (!artifactId || !Number.isInteger(targetVersion) || targetVersion < 1) {
     return failTool("artifact and a positive integer version are required.");
    }
    if (!(await scopedSource(artifactId))) return failTool(NOT_HERE(artifactId));
    const existing = this.db.prepare("SELECT * FROM publications WHERE artifact_id=?").get(artifactId);
    if (!existing || existing.status !== "published") {
     return failTool("This artifact has no active published site to restore.");
    }
    const keptBefore = Boolean(existing.keep_updated);
    const prepared = await this.prepare({
     action: "rollback",
     publicationId: existing.id,
     version: targetVersion,
     actor,
     actorName: "",
    });
    await this.confirm(prepared.id, prepared.revision);
    const settled = await this.waitForOperation(prepared.id);
    const pub = this.pub(existing.id);
    if (settled.status === "failed" || settled.status === "unknown") {
     return failTool(settled.error || `Restore ended in state ${settled.status}.`);
    }
    const statusWord = settled.status === "published" ? "live" : settled.status;
    const keepTurnedOff = keptBefore && !pub.keep_updated;
    const out = {
     status: statusWord,
     version: targetVersion,
     url: pub.url,
     access: pub.access_mode,
     operationId: settled.id,
     ...(keepTurnedOff ? { keepUpToDate: false } : {}),
    };
    return okTool(`Restored v${targetVersion} at ${pub.url}${keepTurnedOff ? ". Keep up to date was turned off, so the site stays on this version." : ""}`, out);
   }

   return failTool(`Unknown tool ${req.tool}. Available tools: sites, publish, status, restore.`);
  } catch (e) {
   return failTool(e instanceof RemoteError ? e.message : "The Cloudflare Pages tool could not complete the request.");
  }
 }
}
