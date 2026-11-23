import { randomUUID, createHash } from "node:crypto";
import { RemoteError } from "./cloudflare.mjs";
import { PublicationAccess, accessConfig, accessHash } from "./access.mjs";
import { PublicationAnalytics, analyticsURL } from "./analytics.mjs";
import { scanBundleForSecrets, tokenTemplateURL, maskAccountId, shortSlug, DASHBOARD_PERMISSION_LABELS } from "./scan.mjs";

const active = ["prepared", "queued", "creating", "protecting", "analytics", "uploading", "deploying", "verifying", "removing", "rolling-back", "unknown"];
const PUBLISHABLE_KINDS = new Set(["page", "design"]);
const now = () => new Date().toISOString();
const digest = (x) => createHash("sha256").update(JSON.stringify(x)).digest("hex");

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
  this.access = new PublicationAccess({ db, remote, configuration: () => this.configuration() });
  this.analytics = new PublicationAnalytics({ db });
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
   if (accessToken) {
    const ac = this.remote(account, accessToken);
    const org = (await ac.call(`/accounts/${account}/access/organizations`)).result;
    if (!org?.auth_domain || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(org.auth_domain)) {
     return { status: 400, body: { valid: false } };
    }
    const providers = (await ac.call(`/accounts/${account}/access/identity_providers`)).result;
    if (!Array.isArray(providers) || !providers.some((p) => p.type === "onetimepin" && p.id)) {
     return { status: 400, body: { valid: false } };
    }
    await ac.call(`/accounts/${account}/access/apps?per_page=1`);
    this.accessSetupCheck = {
     status: "ready",
     message: "Email-code login configured. Each active reader uses 1 Zero Trust seat.",
     fingerprint: digest(merged),
    };
   }
  } catch (e) {
   const code = e instanceof RemoteError && [400, 401, 403, 409, 429].includes(e.status) ? e.status : 502;
   return { status: code === 404 ? 401 : code, body: { valid: false } };
  }
  this.connectionCheck = {
   status: "ready",
   checkedAt: now(),
   analytics,
   message,
   fingerprint: digest(merged),
  };
  void this.event();
  return { status: 200, body: { valid: true } };
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
 async bundle(id, version) { return this.host("/artifacts/" + encodeURIComponent(id) + "/versions/" + version + "/site", 192 << 20); }

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
   .map((d) => ({ ...d, pruned: Boolean(d.pruned) }));
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
   const warnings = scanBundleForSecrets(b);
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

 async prepare({ artifactId, version, action = "publish", publicationId, deployment, projectName, access, analytics, actor = "owner", actorName = "" }) {
  if (!["publish", "remove", "rollback", "access", "analytics", "rename"].includes(action)) {
   throw new RemoteError("Choose publish, remove, rollback, access, analytics or rename.", 400);
  }
  if (analytics !== undefined && typeof analytics !== "boolean") {
   throw new RemoteError("Choose whether Web Analytics is on or off.", 400);
  }

  let p = publicationId ? this.pub(publicationId) : null;
  let bundle;
  let warnings = [];
  let reuploadRestore = false;
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
    const verMeta = (src?.versions || []).find((v) => v.n === version);
    const kind = verMeta?.kind || src?.artifact?.kind || "page";
    if (!PUBLISHABLE_KINDS.has(kind)) {
     throw new RemoteError("Cloudflare Pages publishes standalone page and design artifacts.", 409);
    }
    if (Array.isArray(verMeta?.capabilities) && verMeta.capabilities.length > 0) {
     throw new RemoteError(`Version ${version} declares workspace capabilities (${verMeta.capabilities.join(", ")}); prepare a standalone version first.`, 409);
    }
    bundle = await this.bundle(artifactId, version);
    warnings = scanBundleForSecrets(bundle);

    if (!p) p = this.db.prepare("SELECT * FROM publications WHERE artifact_id=?").get(artifactId);
    if (!p) {
     const cfNew = this.remote(c.account, c.token);
     const id = randomUUID();
     const allocated = projectName || (await this.allocateGeneratedProject(cfNew, src.artifact.title, id));
     p = { id, artifact_id: artifactId, title: src.artifact.title, account_id: c.account, project: allocated, created_at: now() };
     this.db
      .prepare("INSERT INTO publications(id,artifact_id,title,account_id,project,created_at,generated_name) VALUES(?,?,?,?,?,?,?)")
      .run(p.id, p.artifact_id, p.title, p.account_id, p.project, p.created_at, projectName ? 0 : 1);
     p = this.pub(p.id);
    } else if (p.status === "removed") {
     const cfRemoved = this.remote(c.account, c.token);
     const previousProject = p.project;
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
   }

   if (action === "rename") {
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
   if (config.mode === "restricted" && action !== "remove") {
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

   const restoreMessage = reuploadRestore
    ? `Restore version ${version} on ${p.project}.pages.dev (re-uploaded from your local COGNIX[WS] artifact copy because Cloudflare pruned the older deployment).`
    : `Restore version ${version} on ${p.project}.pages.dev.`;

   const confirmation = {
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
              : `Publish “${p.title}”, version ${version}, to ${p.project}.pages.dev in Cloudflare account ${maskAccountId(p.account_id)}. ${audience}${coverage}`,
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
              : "Publish",
    danger: action === "remove" || action === "rename" || (p.access_mode === "restricted" && config.mode === "public"),
   };

   if (confirmation.message.length > 2000) {
    throw new RemoteError("The reader list or project changes are too large for one confirmation. Reduce the reader list or review Cloudflare.", 409);
   }
   const revision = digest({ id, confirmation, version, digest: bundle?.digest || null, snapshot, deployment: deployment || null, access: config, accessSnapshot });
   confirmation.revision = revision;
   this.db
    .prepare(
     "INSERT INTO operations(id,publication_id,action,version,digest,deployment,status,confirmation,revision,snapshot,access_config,access_snapshot,analytics,actor,actor_name,warnings,created_at,updated_at) VALUES(?,?,?,?,?,?,'prepared',?,?,?,?,?,?,?,?,?,?,?)",
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
     now(),
     now(),
    );
   await this.event();
   return this.operation(id);
  } catch (e) {
   this.recordAuthError(e, c);
   throw e;
  }
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
    .finally(() => this.running.delete(id)),
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
  const who = op.actor_name || op.actor.slice(6) || "An agent";
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

 async finish(cf, p, op, deployment) {
  const d = await cf.deployment(p.project, deployment);
  const status = d.latest_stage?.status;
  if (["failure", "failed", "canceled", "cancelled"].includes(status)) {
   this.set(op.id, "failed", { error: "Cloudflare could not publish this version. The previous publication is retained." });
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
  this.db.exec("BEGIN IMMEDIATE");
  try {
   this.db
    .prepare("UPDATE publications SET status='published',version=?,digest=?,deployment=?,url=?,undo_version=? WHERE id=?")
    .run(op.version, op.digest, deployment, url, nextUndo, p.id);
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
  let effect = recovery && ["creating", "protecting", "analytics", "deploying", "verifying", "removing", "rolling-back", "unknown"].includes(op.status);
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
     this.db.prepare("UPDATE publications SET status='removed',undo_version=NULL WHERE id=?").run(p.id);
     this.db.prepare("UPDATE deployments SET pruned=1 WHERE publication_id=?").run(p.id);
     this.set(id, "removed");
     return;
    }
    if (recovery && ["removing", "unknown"].includes(op.status)) {
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
    this.db.prepare("UPDATE publications SET status='removed',undo_version=NULL WHERE id=?").run(p.id);
    this.db.prepare("UPDATE deployments SET pruned=1 WHERE publication_id=?").run(p.id);
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
  }
 }

 async tick() {
  if (this.closing) return;
  for (const op of this.db.prepare("SELECT id FROM operations WHERE status='verifying'").all()) {
   this.launch(op.id, true);
  }
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
  const agentName = req.context?.agentName || agentId;
  const actor = `agent:${agentId}`;

  try {
   if (req.tool === "sites") {
    const st = await this.state();
    const filter = args.filter || "all";
    const list = st.publications
     .filter((p) => !p.otherAccount)
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
     const op = this.operation(String(args.operation));
     const p = this.pub(op.publication_id);
     const out = {
      operation: { id: op.id, action: op.action, status: op.status, version: op.version, error: op.error || null },
      artifact: p?.artifact_id || null,
      url: p?.url || null,
      liveVersion: p?.version || null,
     };
     return okTool(`Operation ${op.id}: ${op.status}${op.error ? " — " + op.error : ""}`, out);
    }
    if (!args.artifact) return failTool("Provide artifact or operation.");
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
     otherAccount: pub.otherAccount || undefined,
     operation: latestOp ? { id: latestOp.id, action: latestOp.action, status: latestOp.status, version: latestOp.version, error: latestOp.error || null } : null,
    };
    return okTool(`${pub.title}: ${pub.siteStatus}${pub.url ? " at " + pub.url : ""}`, out);
   }

   if (req.tool === "publish") {
    const artifactId = String(args.artifact || "").trim();
    if (!artifactId) return failTool("artifact is required.");
    const existing = this.db.prepare("SELECT * FROM publications WHERE artifact_id=?").get(artifactId);
    // D3 human-only boundaries:
    if (existing && existing.status !== "removed") {
     if (existing.access_mode === "restricted" && args.access === "public") {
      return failTool("Making a restricted site public requires the owner in Sites; agents can only keep restricted access or update readers.");
     }
     if (args.projectName && args.projectName !== existing.project && existing.identity) {
      return failTool("Changing an existing site's address requires the owner in Sites.");
     }
    }
    const src = await this.source(artifactId);
    const targetVersion = Number.isInteger(args.version) && args.version >= 1 ? args.version : src?.artifact?.liveVersion;
    if (!targetVersion) return failTool("Artifact has no live version to publish.");
    const desiredAccess =
     args.access !== undefined || args.emails !== undefined
      ? { mode: args.access || existing?.access_mode || "public", emails: args.emails || (existing ? JSON.parse(existing.access_emails) : []) }
      : undefined;
    const prepared = await this.prepare({
     action: "publish",
     artifactId,
     version: targetVersion,
     projectName: args.projectName,
     access: desiredAccess,
     analytics: args.analytics,
     actor,
     actorName: agentName,
    });
    const warnMessages = (prepared.warnings || [])
     .filter(() => (desiredAccess?.mode || existing?.access_mode || "public") === "public")
     .map((w) => w.message);
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
    const out = {
     status: statusWord,
     version: targetVersion,
     url: pub.url || `https://${pub.project}.pages.dev/`,
     access: pub.access_mode,
     operationId: settled.id,
     ...(warnMessages.length ? { warnings: warnMessages } : {}),
    };
    const warnSuffix = warnMessages.length ? ` (${warnMessages.join("; ")})` : "";
    return okTool(`${statusWord === "live" ? "Published" : "Publishing"} v${targetVersion} at ${out.url}${warnSuffix}`, out);
   }

   if (req.tool === "restore") {
    const artifactId = String(args.artifact || "").trim();
    const targetVersion = Number(args.version);
    if (!artifactId || !Number.isInteger(targetVersion) || targetVersion < 1) {
     return failTool("artifact and a positive integer version are required.");
    }
    const existing = this.db.prepare("SELECT * FROM publications WHERE artifact_id=?").get(artifactId);
    if (!existing || existing.status !== "published") {
     return failTool("This artifact has no active published site to restore.");
    }
    const prepared = await this.prepare({
     action: "rollback",
     publicationId: existing.id,
     version: targetVersion,
     actor,
     actorName: agentName,
    });
    await this.confirm(prepared.id, prepared.revision);
    const settled = await this.waitForOperation(prepared.id);
    const pub = this.pub(existing.id);
    if (settled.status === "failed" || settled.status === "unknown") {
     return failTool(settled.error || `Restore ended in state ${settled.status}.`);
    }
    const statusWord = settled.status === "published" ? "live" : settled.status;
    const out = {
     status: statusWord,
     version: targetVersion,
     url: pub.url,
     access: pub.access_mode,
     operationId: settled.id,
    };
    return okTool(`Restored v${targetVersion} at ${pub.url}`, out);
   }

   return failTool(`Unknown tool ${req.tool}. Available tools: sites, publish, status, restore.`);
  } catch (e) {
   return failTool(e instanceof RemoteError ? e.message : "The Cloudflare Pages tool could not complete the request.");
  }
 }
}
