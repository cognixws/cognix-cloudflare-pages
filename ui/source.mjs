import { z } from "zod";

const projectNameSchema = z
 .string()
 .trim()
 .regex(/^[a-z0-9][a-z0-9-]{0,57}$/, "Use lowercase letters, numbers and dashes (up to 58 characters).");

const publicationSchema = z.object({
 artifactId: z.string().min(1, "Choose an artifact."),
 version: z.number().int().positive("Choose a version."),
 projectName: projectNameSchema.optional(),
});

const accessSchema = z.discriminatedUnion("mode", [
 z.object({
  mode: z.literal("public"),
  emails: z.array(z.string()).transform(() => []),
 }),
 z.object({
  mode: z.literal("restricted"),
  emails: z
   .array(z.email("Enter valid email addresses separated by commas."))
   .min(1, "Enter at least one allowed email address.")
   .max(50, "Enter at most 50 email addresses."),
 }),
]);

function parseAccess(mode, text) {
 const r = accessSchema.safeParse({
  mode,
  emails: String(text || "")
   .split(/[\s,;]+/)
   .filter(Boolean)
   .map((e) => e.toLowerCase()),
 });
 if (!r.success) throw new Error(r.error.issues[0].message);
 return r.data;
}

const ACTIVE_OPS = new Set([
 "prepared",
 "queued",
 "creating",
 "protecting",
 "analytics",
 "uploading",
 "deploying",
 "verifying",
 "removing",
 "rolling-back",
 "unknown",
]);

const esc = (s) =>
 String(s ?? "").replace(
  /[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
 );

function formatWhen(iso) {
 if (!iso) return "—";
 const d = new Date(iso);
 if (Number.isNaN(d.getTime())) return "—";
 return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function kindLabel(kind) {
 if (kind === "design") return "Design";
 if (kind === "page") return "Page";
 return kind || "Artifact";
}

(async function () {
 const root = document.getElementById("root");
 const [processDoor, confirmDoor, events, context, links, places] = await Promise.all([
  picode.use("process"),
  picode.use("confirm"),
  picode.use("events"),
  picode.use("context"),
  picode.use("links"),
  picode.use("places"),
 ]);

 let state = null;
 let view = "list"; // "list" | "review" | "detail"
 let originArtifactId = "";
 let reviewArtifactId = "";
 let reviewVersion = 0;
 let reviewData = null;
 let reviewLoading = false;
 let reviewSeq = 0;

 let projectName = "";
 let projectTouched = false;
 let accessMode = "public";
 let accessEmails = "";
 let analyticsOn = true;
 let justPublishedSiteId = "";

 let selectedSiteId = "";
 let filter = "all"; // "all" | "update" | "attention" | "private" | "removed"
 let search = "";
 let pickerOpen = false;
 let pickerQuery = "";
 let menuState = null; // { id, x, y }
 let copiedKey = "";
 let copiedTimer = 0;
 let tokenStepOpened = false;

 let accessEditor = null; // { id, mode, emails }
 let renameEditor = null; // { id, name }

 let busy = "";
 let error = "";
 let note = "";
 let refreshTimer = 0;

 async function request(path, body) {
  if (!processDoor) throw new Error("Cloudflare Pages is turned off in this workspace.");
  const r = await processDoor.request(path, { method: body === undefined ? "GET" : "POST", body });
  let d;
  try {
   d = JSON.parse(r.body);
  } catch {
   throw new Error("The extension returned an unreadable response.");
  }
  if (r.status >= 400) throw new Error(d.error || "The operation could not run.");
  return d;
 }

 const isReady = () => state?.connection?.status === "ready";
 const canRestrict = (mode) => mode !== "restricted" || state?.accessSetup?.status === "ready";

 // Synchronous host navigation helpers (preserve user activation for places.* and links.open).
 function goSettings() {
  if (places?.settings) return places.settings();
  if (links?.open) return links.open(new URL("/#/extensions/cloudflare-pages", location.href).href);
 }
 function goArtifact(id) {
  if (!id) return;
  if (places?.artifact) return places.artifact(id);
  if (links?.open) return links.open(new URL("/#/artifacts/" + encodeURIComponent(id), location.href).href);
 }
 function goAgent(id) {
  if (!id) return;
  if (places?.agent) return places.agent(id);
 }
 function openExternal(url) {
  if (!url) return;
  if (links?.open) return links.open(url);
 }
 function copyText(text, key) {
  if (!text || !links?.copy) return;
  void links.copy(text).then(() => {
   copiedKey = key;
   clearTimeout(copiedTimer);
   render();
   copiedTimer = setTimeout(() => {
    copiedKey = "";
    render();
   }, 1800);
  });
 }

 function siteBadge(p) {
  const op = p.operations?.find((o) => ACTIVE_OPS.has(o.status));
  if (p.otherAccount) return `<span class="badge warn">Other account</span>`;
  if (p.status === "removed") return `<span class="badge">Removed</span>`;
  if (op && op.status === "unknown") return `<span class="badge warn"><span class="badge-dot"></span>Needs check</span>`;
  if (op && op.status !== "prepared") return `<span class="badge accent"><span class="badge-dot"></span>Updating…</span>`;
  if (p.siteStatus === "attention" || p.status === "failed") return `<span class="badge danger"><span class="badge-dot"></span>Needs attention</span>`;
  if (p.siteStatus === "update" && p.latestVersion) {
   return `<span class="badge accent"><span class="badge-dot"></span>v${p.version} · v${p.latestVersion} ready</span>`;
  }
  if (p.status === "published" && p.version) {
   return `<span class="badge ok"><span class="badge-dot"></span>Live · v${p.version}</span>`;
  }
  return `<span class="badge">Draft</span>`;
 }

 function renderStepProgress(op) {
  const s = op.status;
  const up = op.progress && op.progress.total > 0 ? op.progress : null;
  const pct = up ? Math.max(4, Math.min(100, Math.round((up.uploaded / up.total) * 100))) : 0;
  const steps =
   op.action === "remove"
    ? [
       { key: "removing", label: "Remove Cloudflare Pages project and clean up access" },
      ]
    : op.action === "rollback"
      ? [
         { key: "rolling-back", label: "Restore target version on Cloudflare Pages" },
         { key: "verifying", label: "Check live link" },
        ]
      : [
         { key: "prep", label: "Prepare project and access rules", match: ["queued", "creating", "protecting", "analytics"] },
         { key: "uploading", label: up ? `Upload files (${up.uploaded} / ${up.total})` : "Upload files", match: ["uploading"], bar: up ? pct : null },
         { key: "deploying", label: "Activate deployment", match: ["deploying"] },
         { key: "verifying", label: "Check live link", match: ["verifying"] },
        ];

  let activeIdx = steps.findIndex((st) => (st.match ? st.match.includes(s) : st.key === s));
  if (activeIdx < 0) activeIdx = 0;

  return `<div class="progress-box" role="status" aria-live="polite">
   <ul class="step-list">
    ${steps
     .map((st, idx) => {
      const cls = idx < activeIdx ? "done" : idx === activeIdx ? "active" : "";
      return `<li class="step-item ${cls}">
       <span class="step-dot" aria-hidden="true"></span>
       <span>${esc(st.label)}</span>
       ${idx === activeIdx && st.bar !== null && st.bar !== undefined ? `<span class="op-bar" aria-hidden="true"><i style="width:${st.bar}%"></i></span>` : ""}
      </li>`;
     })
     .join("")}
   </ul>
  </div>`;
 }

 function renderConnectionBanner() {
  const c = state?.connection;
  if (!c || c.status === "ready") return "";
  if (c.status === "not-configured") {
   return `<div class="state-box">
    <h2>${tokenStepOpened ? "Token ready to paste" : "Cloudflare account not connected"}</h2>
    <p class="muted">${
     tokenStepOpened
      ? "Paste your Cloudflare Account ID and the API token you created in Settings; saving verifies your connection right away."
      : "Create a Cloudflare API token with Cloudflare Pages: Edit, Account Settings: Edit and Account Analytics: Read, then paste it with your Account ID in Settings."
    }</p>
    <div class="row state-actions" data-align-row data-align-wrap>
     ${
      tokenStepOpened
       ? `<button type="button" class="primary" data-sync="settings">Open settings</button>
          <button type="button" data-sync="create-token">Open Cloudflare again</button>`
       : `<button type="button" class="primary" data-sync="create-token">Create a token</button>
          <button type="button" data-sync="settings">I already have a token</button>`
     }
    </div>
   </div>`;
  }
  if (c.status === "reconnect") {
   return `<div class="banner warn" role="alert">
    <div class="banner-copy">
     <span class="banner-title">Reconnect Cloudflare</span>
     <span class="muted">${esc(c.message)}</span>
    </div>
    <div class="row" data-align-row data-align-wrap>
     <button type="button" class="primary" data-sync="settings">Open settings</button>
    </div>
   </div>`;
  }
  if (c.status === "expired" || c.expired) {
   return `<div class="banner warn" role="alert">
    <div class="banner-copy">
     <span class="banner-title">Cloudflare token needs attention</span>
     <span class="muted">${esc(c.message)}</span>
    </div>
    <div class="row" data-align-row data-align-wrap>
     <button type="button" class="primary" data-sync="settings">Update token</button>
    </div>
   </div>`;
  }
  if (c.status === "unchecked") {
   return `<div class="banner" role="status">
    <div class="banner-copy">
     <span class="banner-title">Connection ready to check</span>
     <span class="muted">Verify that your saved Cloudflare credentials can access Pages projects in this account.</span>
    </div>
    <div class="row" data-align-row data-align-wrap>
     <button type="button" class="primary" data-action="check-connection" ${busy ? "disabled" : ""}>${busy === "check-connection" ? "Checking…" : "Check connection"}</button>
    </div>
   </div>`;
  }
  return `<div class="banner danger" role="alert">
   <div class="banner-copy">
    <span class="banner-title">Cloudflare connection problem</span>
    <span class="muted">${esc(c.message || "Could not verify Cloudflare access.")}</span>
   </div>
   <div class="row" data-align-row data-align-wrap>
    ${
     c.retryable
      ? `<button type="button" class="primary" data-action="check-connection" ${busy ? "disabled" : ""}>Check again</button>`
      : `<button type="button" class="primary" data-sync="settings">Open settings</button>`
    }
   </div>
  </div>`;
 }

 function renderAccessControls(prefix, mode, emails) {
  const setup = state?.accessSetup;
  const ready = setup?.status === "ready";
  return `<div class="field-stack">
   <div class="field">
    <span class="field-label">Who can open it</span>
    <div class="seg" role="group" aria-label="Who can open it" data-align-row data-align-wrap>
     <button type="button" aria-pressed="${mode === "public"}" data-action="${prefix}-mode" data-id="public" ${busy ? "disabled" : ""}>Anyone with the link</button>
     <button type="button" aria-pressed="${mode === "restricted"}" data-action="${prefix}-mode" data-id="restricted" ${busy ? "disabled" : ""}>Only people I choose</button>
    </div>
    <p class="muted small">${
     mode === "public"
      ? "Anyone with the link can open this site; preview links stay reachable for up to 30 days."
      : "Readers sign in with a one-time email code (uses 1 Cloudflare Zero Trust seat per active reader)."
    }</p>
   </div>
   ${
    mode === "restricted"
     ? `<label class="field">
         <span class="field-label">Allowed email addresses</span>
         <input id="${prefix}-emails" type="text" placeholder="you@company.com, teammate@company.com" value="${esc(emails)}">
        </label>
        ${
         ready
          ? `<p class="muted small">Cloudflare Access one-time PIN login is verified for this account.</p>`
          : `<div class="banner warn" role="status">
              <div class="banner-copy">
               <span class="banner-title">Restricted access needs setup</span>
               <span class="muted">${esc(setup?.message || "Save a Cloudflare Access API token in Settings and verify One-time PIN login.")}</span>
              </div>
              <div class="row" data-align-row data-align-wrap>
               ${
                setup?.status === "not-configured" || setup?.settingsRequired
                 ? `<button type="button" data-sync="settings">Open settings</button>`
                 : `<button type="button" data-action="access-setup" ${busy ? "disabled" : ""}>${busy === "access-setup" ? "Checking…" : "Check setup"}</button>`
               }
              </div>
             </div>`
        }`
     : ""
   }
  </div>`;
 }

 function renderRefusalState(refusal, artId) {
  const authorId = refusal.author || reviewData?.author || "";
  const authorLabel = refusal.authorName || reviewData?.authorName || (authorId ? "the agent" : "");
  const canMessageAuthor = Boolean(authorId && places?.agent);

  if (refusal.code === "local-capabilities") {
   const capLabels = (refusal.capabilities || []).map((c) => (c === "picode" ? "workspace data" : c));
   return `<div class="state-box">
    <h2>Version ${refusal.version} uses COGNIX[WS] data</h2>
    <p class="muted">This version uses workspace capabilities (${esc(capLabels.join(", "))}) that do not run on a public static site.</p>
    <div class="row state-actions" data-align-row data-align-wrap>
     ${
      canMessageAuthor
       ? `<button type="button" class="primary" data-sync="agent" data-id="${esc(authorId)}">Ask ${esc(authorLabel)} for a standalone version</button>
          <button type="button" data-sync="artifact" data-id="${esc(artId)}">Back to artifact</button>`
       : `<button type="button" class="primary" data-sync="artifact" data-id="${esc(artId)}">Back to artifact</button>`
     }
    </div>
   </div>`;
  }

  if (refusal.code === "unsupported-kind") {
   return `<div class="state-box">
    <h2>Only pages and designs publish as sites</h2>
    <p class="muted">This ${esc(refusal.kind)} artifact opens in COGNIX[WS]'s built-in viewer rather than as a standalone web site.</p>
    <div class="row state-actions" data-align-row data-align-wrap>
     <button type="button" class="primary" data-sync="artifact" data-id="${esc(artId)}">Back to artifact</button>
    </div>
   </div>`;
  }

  if (refusal.code === "other-account") {
   return `<div class="state-box">
    <h2>Published in another Cloudflare account</h2>
    <p class="muted">This site belongs to Cloudflare account ${esc(refusal.accountHint)}; switch accounts in Settings to update or remove it.</p>
    <div class="row state-actions" data-align-row data-align-wrap>
     <button type="button" class="primary" data-sync="settings">Open settings</button>
    </div>
   </div>`;
  }

  return `<div class="state-box">
   <h2>Version ${refusal.version} can't be published</h2>
   <p class="muted">${esc(refusal.message || "This version is missing a required static entry or asset.")}</p>
   <div class="row state-actions" data-align-row data-align-wrap>
    ${
     canMessageAuthor
      ? `<button type="button" class="primary" data-sync="agent" data-id="${esc(authorId)}">Ask ${esc(authorLabel)} to fix</button>
         <button type="button" data-sync="artifact" data-id="${esc(artId)}">Back to artifact</button>`
      : `<button type="button" class="primary" data-action="reload-review">Try again</button>
         <button type="button" data-sync="artifact" data-id="${esc(artId)}">Back to artifact</button>`
    }
   </div>
  </div>`;
 }

 function renderReviewView() {
  const nonRemovedCount = (state?.publications || []).filter((p) => p.status !== "removed").length;
  const backArtId = originArtifactId || reviewArtifactId;
  const nav = `<header class="topbar">
   <div class="row" data-align-row data-align-wrap>
    ${
     backArtId
      ? `<button type="button" class="ghost" data-sync="artifact" data-id="${esc(backArtId)}">← Back to artifact</button>`
      : `<button type="button" class="ghost" data-action="nav-list">← Sites</button>`
    }
   </div>
   <div class="row" data-align-row data-align-wrap>
    <button type="button" data-action="nav-list">${nonRemovedCount > 0 ? `All sites (${nonRemovedCount})` : "All sites"}</button>
   </div>
  </header>`;

  if (!isReady()) {
   return `<div class="shell narrow">
    ${nav}
    ${renderConnectionBanner()}
   </div>`;
  }

  if (reviewLoading || !reviewData) {
   return `<div class="shell narrow">
    ${nav}
    <div class="panel panel-pad">
     <h2>Loading artifact…</h2>
     <div class="skeleton" aria-label="Loading artifact review"><div></div><div></div></div>
    </div>
   </div>`;
  }

  const art = reviewData.artifact;
  const versions = reviewData.versions || [];
  const latestPub = (state?.publications || []).find((p) => p.artifact_id === art.id) || reviewData.publication;
  const activeOp = latestPub?.operations?.find((o) => ACTIVE_OPS.has(o.status));
  const hasExistingProject = Boolean(latestPub && latestPub.hasProject && latestPub.status !== "removed");
  const displayProject = hasExistingProject ? latestPub.project : projectName;
  const isLiveJustNow = Boolean(
   justPublishedSiteId &&
    latestPub &&
    latestPub.id === justPublishedSiteId &&
    latestPub.status === "published" &&
    latestPub.version === reviewData.selectedVersion &&
    latestPub.url,
  );

  const headerSection = `<div class="panel-section review-head">
   <div class="review-meta">
    <div class="row">
     <h1>${esc(art.title || art.id)}</h1>
     <span class="badge">${esc(kindLabel(art.kind))}</span>
    </div>
    <p class="muted small">${
     hasExistingProject
      ? `Updates ${esc(latestPub.project)}.pages.dev${latestPub.version ? ` · Currently live: v${latestPub.version}` : ""}`
      : `Publishes a dedicated Cloudflare Pages site${reviewData.fileCount ? ` · ${reviewData.fileCount} file${reviewData.fileCount === 1 ? "" : "s"}` : ""}`
    }</p>
   </div>
   <label class="version-picker">
    <span class="muted small">Version</span>
    <select id="review-version" aria-label="Version" ${busy ? "disabled" : ""}>
     ${versions
      .map(
       (v) =>
        `<option value="${v.n}" ${v.n === reviewData.selectedVersion ? "selected" : ""}>Version ${v.n}${v.n === art.liveVersion ? " (latest)" : ""}</option>`,
      )
      .join("")}
    </select>
   </label>
  </div>`;

  if (reviewData.refusal) {
   return `<div class="shell narrow">
    ${nav}
    <div class="panel">${headerSection}</div>
    ${renderRefusalState(reviewData.refusal, art.id)}
   </div>`;
  }

  if (activeOp && activeOp.status === "unknown") {
   return `<div class="shell narrow">
    ${nav}
    <div class="panel">${headerSection}</div>
    <div class="state-box">
     <h2>Delivery check needed</h2>
     <p class="muted">Cloudflare did not confirm the last step; check the result before starting another publication.</p>
     <div class="row state-actions" data-align-row data-align-wrap>
      <button type="button" class="primary" data-action="check-op" data-id="${esc(activeOp.id)}" ${busy ? "disabled" : ""}>Check result</button>
     </div>
    </div>
   </div>`;
  }

  if (activeOp && activeOp.status !== "prepared") {
   return `<div class="shell narrow">
    ${nav}
    <section class="panel" aria-label="Publishing site">
     ${headerSection}
     <div class="panel-section">
      ${renderStepProgress(activeOp)}
     </div>
    </section>
   </div>`;
  }

  const warningSection =
   reviewData.warnings && reviewData.warnings.length > 0
    ? (() => {
       const files = [...new Set(reviewData.warnings.map((w) => w.file))].slice(0, 3).join(", ");
       const kinds = [...new Set(reviewData.warnings.map((w) => w.label))].slice(0, 2).join(", ");
       return `<div class="banner warn" role="status">
        <div class="banner-copy">
         <span class="banner-title">Possible key or token format found</span>
         <span class="muted">Check ${esc(files)} (${esc(kinds)}) before publishing publicly; static site files are readable by visitors.</span>
        </div>
        <div class="row" data-align-row data-align-wrap>
         <button type="button" data-sync="artifact" data-id="${esc(art.id)}">Inspect artifact</button>
        </div>
       </div>`;
      })()
    : "";

  const liveBanner = isLiveJustNow
   ? `<div class="banner ok" role="status">
       <div class="banner-copy">
        <span class="banner-title">Version ${latestPub.version} is live</span>
        <span class="muted mono">${esc(latestPub.url)}</span>
       </div>
       <div class="row" data-align-row data-align-wrap>
        <button type="button" class="primary" data-sync="copy" data-url="${esc(latestPub.url)}" data-key="live">${copiedKey === "live" ? "Copied" : "Copy link"}</button>
        <button type="button" data-sync="open-url" data-url="${esc(latestPub.url)}">Open site</button>
        <button type="button" data-action="open-detail" data-id="${esc(latestPub.id)}">Manage site</button>
       </div>
      </div>`
   : "";

  return `<div class="shell narrow">
   ${nav}
   ${error ? `<div class="banner danger" role="alert"><div class="banner-copy"><span class="banner-title">Could not prepare publication</span><span class="muted">${esc(error)}</span></div></div>` : ""}
   ${note ? `<div class="banner ok" role="status"><div class="banner-copy"><span class="banner-title">${esc(note)}</span></div></div>` : ""}
   ${liveBanner}
   ${warningSection}
   <section class="panel" aria-label="Publish to the web">
    <form id="review-form" noValidate>
     ${headerSection}
     <div class="panel-section field-stack">
      <div class="field">
       <label class="field-label" for="project-name">Site address</label>
       ${
        hasExistingProject
         ? `<div class="row spread">
             <span class="mono">https://${esc(latestPub.project)}.pages.dev</span>
             <button type="button" class="ghost" data-action="open-detail" data-id="${esc(latestPub.id)}">Manage site</button>
            </div>`
         : `<div class="subdomain-row" data-align-row data-align-wrap>
             <input id="project-name" class="subdomain-input" type="text" value="${esc(displayProject)}" placeholder="${esc(reviewData.suggestedProject)}" autocomplete="off" spellcheck="false">
             <span class="subdomain-suffix">.pages.dev</span>
            </div>`
       }
      </div>
      ${renderAccessControls("review-access", accessMode, accessEmails)}
      <label class="toggle-line">
       <span>Count visits with Cloudflare Web Analytics <span class="muted small">(cookie-free)</span></span>
       <input id="review-analytics" type="checkbox" ${analyticsOn ? "checked" : ""}>
      </label>
     </div>
     <div class="panel-section review-footer">
      <span class="muted small">${
       hasExistingProject && latestPub.version === reviewData.selectedVersion && latestPub.access_mode === accessMode
        ? `Version ${reviewData.selectedVersion} is currently published.`
        : `Publishes to Cloudflare account ${esc(state?.accountHint || "")}.`
      }</span>
      <div class="row" data-align-row data-align-wrap>
       ${
        activeOp?.status === "prepared"
         ? `<button type="button" data-action="cancel-op" data-id="${esc(activeOp.id)}" ${busy ? "disabled" : ""}>Cancel</button>
            <button type="button" class="primary" data-action="confirm-op" data-id="${esc(activeOp.id)}" ${busy ? "disabled" : ""}>Confirm v${reviewData.selectedVersion}</button>`
         : `<button type="submit" class="primary" ${busy || !canRestrict(accessMode) ? "disabled" : ""}>${
             busy === "publish" ? "Preparing…" : `Publish v${reviewData.selectedVersion}`
            }</button>`
       }
      </div>
     </div>
    </form>
   </section>
  </div>`;
 }

 function renderDetailView() {
  const p = (state?.publications || []).find((item) => item.id === selectedSiteId);
  if (!p) {
   view = "list";
   return renderListView();
  }
  const activeOp = p.operations?.find((o) => ACTIVE_OPS.has(o.status));
  const lastOp = activeOp || p.operations?.[0];
  const canMutate = isReady() && !p.otherAccount && !activeOp && !busy;

  return `<div class="shell">
   <header class="topbar">
    <div class="row" data-align-row data-align-wrap>
     <button type="button" class="ghost" data-action="nav-list">← Sites</button>
    </div>
    <div class="row" data-align-row data-align-wrap>
     ${p.artifact_id ? `<button type="button" data-sync="artifact" data-id="${esc(p.artifact_id)}">Open artifact</button>` : ""}
     <button type="button" data-sync="settings">Settings</button>
    </div>
   </header>

   ${renderConnectionBanner()}
   ${error ? `<div class="banner danger" role="alert"><div class="banner-copy"><span class="banner-title">Action could not complete</span><span class="muted">${esc(error)}</span></div></div>` : ""}
   ${note ? `<div class="banner ok" role="status"><div class="banner-copy"><span class="banner-title">${esc(note)}</span></div></div>` : ""}

   ${
    p.otherAccount
     ? `<div class="banner warn" role="status">
         <div class="banner-copy">
          <span class="banner-title">Published in another Cloudflare account</span>
          <span class="muted">This site belongs to account ${esc(p.accountHint)}; switch accounts in Settings to update, restore or remove it.</span>
         </div>
         <div class="row" data-align-row data-align-wrap>
          <button type="button" data-sync="settings">Open settings</button>
         </div>
        </div>`
     : ""
   }

   <section class="panel" aria-label="Site overview">
    <div class="panel-section">
     <div class="row spread">
      <div class="topbar-title">
       <h1>${esc(p.title)}</h1>
       ${siteBadge(p)}
       ${p.artifactKind === "design" ? `<span class="badge">Design</span>` : ""}
      </div>
      <div class="row" data-align-row data-align-wrap>
       ${
        p.url && p.status !== "removed"
         ? `<button type="button" data-sync="copy" data-url="${esc(p.url)}" data-key="detail-${esc(p.id)}">${copiedKey === "detail-" + p.id ? "Copied" : "Copy link"}</button>
            <button type="button" class="${p.latestVersion && p.latestVersion > p.version && canMutate ? "" : "primary"}" data-sync="open-url" data-url="${esc(p.url)}">Open site</button>`
         : ""
       }
       ${
        p.latestVersion && p.latestVersion > (p.version || 0) && canMutate
         ? `<button type="button" class="primary" data-action="open-review" data-id="${esc(p.artifact_id)}" data-version="${p.latestVersion}">Publish v${p.latestVersion}</button>`
         : ""
       }
      </div>
     </div>
     <p class="muted detail-url" style="margin-top:6px">${esc(p.url || p.project + ".pages.dev")}</p>
    </div>

    ${
     activeOp && activeOp.status === "unknown"
      ? `<div class="panel-section">
          <div class="banner warn" role="status">
           <div class="banner-copy">
            <span class="banner-title">Delivery check needed</span>
            <span class="muted">${esc(activeOp.error || "Cloudflare did not confirm the last step; check the result before starting another change.")}</span>
           </div>
           <div class="row" data-align-row data-align-wrap>
            <button type="button" class="primary" data-action="check-op" data-id="${esc(activeOp.id)}" ${busy ? "disabled" : ""}>Check result</button>
           </div>
          </div>
         </div>`
      : activeOp && activeOp.status === "prepared"
        ? `<div class="panel-section">
            <div class="banner" role="status">
             <div class="banner-copy">
              <span class="banner-title">Confirmation pending</span>
              <span class="muted">Confirm or cancel the prepared change to continue.</span>
             </div>
             <div class="row" data-align-row data-align-wrap>
              <button type="button" data-action="cancel-op" data-id="${esc(activeOp.id)}" ${busy ? "disabled" : ""}>Cancel</button>
              <button type="button" class="primary" data-action="confirm-op" data-id="${esc(activeOp.id)}" ${busy ? "disabled" : ""}>Review change</button>
             </div>
            </div>
           </div>`
        : activeOp
          ? `<div class="panel-section">${renderStepProgress(activeOp)}</div>`
          : lastOp?.status === "failed" && lastOp.error
            ? `<div class="panel-section">
                <div class="banner danger" role="alert">
                 <div class="banner-copy">
                  <span class="banner-title">Last operation failed</span>
                  <span class="muted">${esc(lastOp.error)}</span>
                 </div>
                 ${
                  p.artifact_id && canMutate
                   ? `<div class="row" data-align-row data-align-wrap>
                       <button type="button" data-action="open-review" data-id="${esc(p.artifact_id)}" data-version="${p.latestVersion || p.version || 1}">Review again</button>
                      </div>`
                   : ""
                 }
                </div>
               </div>`
            : ""
    }
   </section>

   <section class="panel" aria-label="Versions">
    <div class="panel-section">
     <div class="row spread" style="margin-bottom:8px">
      <h2>Versions</h2>
      <span class="muted small">Preview links last 30 days (up to 100)</span>
     </div>
     ${
      p.undoVersion && p.status === "published" && canMutate
       ? `<div class="banner" style="margin-bottom:12px">
           <div class="banner-copy">
            <span class="banner-title">Restored version ${p.version}</span>
            <span class="muted">You can switch back to version ${p.undoVersion} at any time.</span>
           </div>
           <div class="row" data-align-row data-align-wrap>
            <button type="button" data-action="undo-restore" data-id="${esc(p.id)}" data-version="${p.undoVersion}">Undo to v${p.undoVersion}</button>
           </div>
          </div>`
       : ""
     }
     ${
      p.history && p.history.length > 0
       ? `<div class="version-list">
           ${p.history
            .map((d) => {
             const isCurrent = d.id === p.deployment && p.status !== "removed";
             const canRestoreRow = !isCurrent && p.status === "published" && canMutate && (d.project === p.project || d.pruned);
             return `<div class="version-row">
              <div class="version-info">
               <div class="row">
                <strong>Version ${d.version}</strong>
                ${isCurrent ? `<span class="badge ok">Live</span>` : ""}
                ${!isCurrent && d.pruned ? `<span class="badge">Local copy ready</span>` : ""}
               </div>
               <span class="muted small">${esc(formatWhen(d.created_at))}${d.pruned && !isCurrent ? " · Preview pruned on Cloudflare; restores from COGNIX[WS]" : ""}</span>
              </div>
              <div class="row" data-align-row data-align-wrap>
               ${canRestoreRow ? `<button type="button" data-action="restore" data-id="${esc(p.id)}/${esc(d.id)}">Restore</button>` : ""}
              </div>
             </div>`;
            })
            .join("")}
          </div>`
       : `<p class="muted small">No deployment history recorded yet.</p>`
     }
    </div>
   </section>

   ${
    p.hasProject && p.status !== "removed"
     ? `<section class="panel" aria-label="Site settings">
         <div class="panel-section">
          <div class="row spread">
           <div>
            <h2>Access</h2>
            <p class="muted small">${
             p.access_mode === "restricted"
              ? `Only people I choose · ${p.access_emails.length} allowed email${p.access_emails.length === 1 ? "" : "s"}${p.access_verified_at ? ` · Verified ${esc(formatWhen(p.access_verified_at))}` : ""}`
              : "Anyone with the link can open this site."
            }</p>
           </div>
           ${
            accessEditor?.id === p.id
             ? ""
             : `<div class="row" data-align-row data-align-wrap>
                 ${p.access_mode === "restricted" ? `<button type="button" data-action="access-verify" data-id="${esc(p.id)}" ${!canMutate ? "disabled" : ""}>${busy === "access-verify" ? "Checking…" : "Check now"}</button>` : ""}
                 <button type="button" data-action="access-edit" data-id="${esc(p.id)}" ${!canMutate ? "disabled" : ""}>Change access</button>
                </div>`
           }
          </div>
          ${
           accessEditor?.id === p.id
            ? `<form id="access-form" data-site="${esc(p.id)}" noValidate style="margin-top:14px" class="field-stack">
                ${renderAccessControls("edit-access", accessEditor.mode, accessEditor.emails)}
                <div class="row" data-align-row data-align-wrap>
                 <button type="submit" class="primary" ${busy || !canRestrict(accessEditor.mode) ? "disabled" : ""}>Save access</button>
                 <button type="button" data-action="access-cancel" ${busy ? "disabled" : ""}>Cancel</button>
                </div>
               </form>`
            : ""
          }
         </div>

         <div class="panel-section">
          <div class="row spread">
           <div>
            <h2>Web Analytics</h2>
            <p class="muted small">${p.analytics ? "Counting cookie-free visits in Cloudflare Web Analytics." : "Visit counting is turned off for new publications."}</p>
           </div>
           <div class="row" data-align-row data-align-wrap>
            ${p.analytics?.url ? `<button type="button" data-sync="open-url" data-url="${esc(p.analytics.url)}">Open in Cloudflare</button>` : ""}
            <button type="button" data-action="analytics-toggle" data-id="${esc(p.id)}" ${!canMutate ? "disabled" : ""}>${p.analytics ? "Turn off" : "Turn on"}</button>
           </div>
          </div>
         </div>

         <div class="panel-section">
          <div class="row spread">
           <div>
            <h2>Site</h2>
            <p class="muted small">Dedicated Cloudflare Pages project <span class="mono">${esc(p.project)}.pages.dev</span>.</p>
           </div>
           <div class="row" data-align-row data-align-wrap>
            ${
             renameEditor?.id === p.id
              ? ""
              : `<button type="button" data-action="rename-edit" data-id="${esc(p.id)}" ${!canMutate || p.access_mode === "restricted" ? "disabled" : ""} ${p.access_mode === "restricted" ? 'title="Restricted sites cannot change address directly"' : ""}>Change address…</button>`
            }
            <button type="button" class="danger" data-action="remove" data-id="${esc(p.id)}" ${!canMutate ? "disabled" : ""}>Remove…</button>
           </div>
          </div>
          ${p.access_mode === "restricted" ? `<p class="muted small" style="margin-top:6px">Restricted sites keep their address; remove the site and publish again to use a new subdomain.</p>` : ""}
          ${
           renameEditor?.id === p.id
            ? `<form id="rename-form" data-site="${esc(p.id)}" noValidate style="margin-top:14px" class="field-stack">
                <div class="field">
                 <label class="field-label" for="rename-name">New site address</label>
                 <div class="subdomain-row" data-align-row data-align-wrap>
                  <input id="rename-name" class="subdomain-input" type="text" placeholder="${esc(p.project)}" value="${esc(renameEditor.name)}" autocomplete="off" spellcheck="false">
                  <span class="subdomain-suffix">.pages.dev</span>
                 </div>
                 <p class="muted small">Retires ${esc(p.project)}.pages.dev and its deployment links after the new address is live.</p>
                </div>
                <div class="row" data-align-row data-align-wrap>
                 <button type="submit" class="primary" ${busy ? "disabled" : ""}>Change address</button>
                 <button type="button" data-action="rename-cancel" ${busy ? "disabled" : ""}>Cancel</button>
                </div>
               </form>`
            : ""
          }
         </div>
        </section>`
     : ""
   }
  </div>`;
 }

 function renderListView() {
  const pubs = state?.publications || [];
  const activePubs = pubs.filter((p) => p.status !== "removed");
  const removedPubs = pubs.filter((p) => p.status === "removed");
  const updateCount = activePubs.filter((p) => p.siteStatus === "update").length;
  const attentionCount = activePubs.filter((p) => p.siteStatus === "attention").length;
  const privateCount = activePubs.filter((p) => p.access_mode === "restricted").length;

  const connChip = isReady()
   ? `<span class="badge ok"><span class="badge-dot"></span>Cloudflare${state?.accountHint ? " · " + esc(state.accountHint) : ""}</span>`
   : state?.connection?.status === "expired" || state?.connection?.status === "reconnect" || state?.connection?.expired
     ? `<span class="badge warn"><span class="badge-dot"></span>Reconnect needed</span>`
     : "";

  const header = `<header class="topbar">
   <div class="topbar-title">
    <h1>Sites</h1>
    ${connChip}
   </div>
   <div class="row" data-align-row data-align-wrap>
    ${isReady() && activePubs.length > 0 ? `<button type="button" class="primary" data-action="open-picker">+ Publish an artifact</button>` : ""}
    <button type="button" data-sync="settings">Settings</button>
   </div>
  </header>`;

  if (state?.connection?.status === "not-configured" && pubs.length === 0) {
   return `<div class="shell">${header}${renderConnectionBanner()}</div>`;
  }

  if (isReady() && activePubs.length === 0 && filter !== "removed") {
   const publishableArtifacts = (state?.artifacts || []).filter((a) => a.kind === "page" || a.kind === "design");
   return `<div class="shell">
    ${header}
    ${error ? `<div class="banner danger" role="alert"><div class="banner-copy"><span class="banner-title">Could not load sites</span><span class="muted">${esc(error)}</span></div></div>` : ""}
    ${
     publishableArtifacts.length > 0
      ? `<div class="state-box">
          <h2>No sites yet</h2>
          <p class="muted">Publish any standalone page or design artifact in this workspace to get a shareable .pages.dev link.</p>
          <div class="row state-actions" data-align-row data-align-wrap>
           <button type="button" class="primary" data-action="open-picker">Publish an artifact</button>
           ${removedPubs.length > 0 ? `<button type="button" data-action="set-filter" data-id="removed">Removed (${removedPubs.length})</button>` : ""}
          </div>
         </div>`
      : `<div class="state-box">
          <h2>No pages or designs yet</h2>
          <p class="muted">Create a standalone page or design artifact in this workspace, then publish it here or from its menu.</p>
          <div class="row state-actions" data-align-row data-align-wrap>
           <button type="button" class="primary" data-action="refresh" ${busy ? "disabled" : ""}>Refresh</button>
          </div>
         </div>`
    }
   </div>`;
  }

  const q = search.trim().toLowerCase();
  const visible = pubs.filter((p) => {
   if (filter === "removed") {
    if (p.status !== "removed") return false;
   } else {
    if (p.status === "removed") return false;
    if (filter === "update" && p.siteStatus !== "update") return false;
    if (filter === "attention" && p.siteStatus !== "attention") return false;
    if (filter === "private" && p.access_mode !== "restricted") return false;
   }
   if (q) {
    const hay = `${p.title} ${p.project} ${p.url || ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
   }
   return true;
  });

  const chipBtn = (id, label, count) =>
   `<button type="button" class="chip ${filter === id ? "active" : ""}" data-action="set-filter" data-id="${id}">${esc(label)}${count > 0 ? ` <span class="chip-count">${count}</span>` : ""}</button>`;

  return `<div class="shell">
   ${header}
   ${renderConnectionBanner()}
   ${error ? `<div class="banner danger" role="alert"><div class="banner-copy"><span class="banner-title">Action could not complete</span><span class="muted">${esc(error)}</span></div></div>` : ""}
   ${note ? `<div class="banner ok" role="status"><div class="banner-copy"><span class="banner-title">${esc(note)}</span></div></div>` : ""}

   <div class="toolbar">
    <div class="chips" role="group" aria-label="Filter sites" data-align-row data-align-wrap>
     ${chipBtn("all", "All", activePubs.length)}
     ${chipBtn("update", "Update ready", updateCount)}
     ${chipBtn("attention", "Needs attention", attentionCount)}
     ${chipBtn("private", "Private", privateCount)}
     ${removedPubs.length > 0 || filter === "removed" ? chipBtn("removed", "Removed", removedPubs.length) : ""}
    </div>
    <div class="search-wrap" data-align-row data-align-wrap>
     <input id="site-search" type="search" placeholder="Search sites…" aria-label="Search sites" value="${esc(search)}">
    </div>
   </div>

   ${
    visible.length === 0
     ? `<div class="state-box">
         <h2>No matching sites</h2>
         <p class="muted">None of your sites match the current filter or search.</p>
         <div class="row state-actions" data-align-row data-align-wrap>
          <button type="button" class="primary" data-action="clear-filter">Show all sites</button>
         </div>
        </div>`
     : `<section class="panel" aria-label="Published sites">
         <div class="sites-head" aria-hidden="true">
          <span>Site</span>
          <span>Status</span>
          <span>Access</span>
          <span>Actions</span>
         </div>
         <div class="sites-list">
          ${visible
           .map((p) => {
            const known = p.status !== "removed" && Boolean(p.url);
            return `<div class="site-row ${p.status === "removed" ? "is-removed" : ""}" data-site-row="${esc(p.id)}">
             <div class="site-main">
              <button type="button" class="site-link-btn" data-action="open-detail" data-id="${esc(p.id)}">
               <span class="site-link-title">${esc(p.title)}</span>
               ${p.artifactKind === "design" ? `<span class="badge">Design</span>` : ""}
              </button>
              <span class="site-sub mono">${esc(p.url ? p.url.replace(/^https?:\/\//, "") : p.project + ".pages.dev")}</span>
             </div>
             <div>${siteBadge(p)}</div>
             <div class="small muted">${
              p.access_mode === "restricted" ? `Restricted (${p.access_emails.length})` : "Public"
             }</div>
             <div class="site-actions" data-align-row data-align-wrap>
              ${
               p.siteStatus === "update" && p.latestVersion && isReady() && !p.otherAccount
                ? `<button type="button" class="primary" data-action="open-review" data-id="${esc(p.artifact_id)}" data-version="${p.latestVersion}">Update v${p.latestVersion}</button>`
                : ""
              }
              ${
               known
                ? `<button type="button" data-sync="copy" data-url="${esc(p.url)}" data-key="row-${esc(p.id)}">${copiedKey === "row-" + p.id ? "Copied" : "Copy"}</button>
                   <button type="button" data-sync="open-url" data-url="${esc(p.url)}">Open</button>`
                : ""
              }
              <button type="button" class="icon-btn" aria-label="Actions for ${esc(p.title)}" aria-haspopup="menu" aria-expanded="${menuState?.id === p.id}" data-action="toggle-menu" data-id="${esc(p.id)}">⋯</button>
             </div>
            </div>`;
           })
           .join("")}
         </div>
        </section>`
   }
  </div>`;
 }

 function renderMenuOverlay() {
  if (!menuState) return "";
  const p = (state?.publications || []).find((item) => item.id === menuState.id);
  if (!p) return "";
  const known = p.status !== "removed" && Boolean(p.url);
  const activeOp = p.operations?.find((o) => ACTIVE_OPS.has(o.status));
  const canRemove = isReady() && !p.otherAccount && !activeOp && p.hasProject && p.status !== "removed";
  return `<div class="menu-backdrop" data-action="close-menu"></div>
   <div class="menu-pop" role="menu" aria-label="Site actions" style="left:${Math.round(menuState.x)}px;top:${Math.round(menuState.y)}px">
    <button type="button" role="menuitem" data-action="open-detail" data-id="${esc(p.id)}">Manage site</button>
    ${known ? `<button type="button" role="menuitem" data-sync="open-url" data-url="${esc(p.url)}">Open site</button>` : ""}
    ${known ? `<button type="button" role="menuitem" data-sync="copy" data-url="${esc(p.url)}" data-key="row-${esc(p.id)}">Copy link</button>` : ""}
    ${p.artifact_id ? `<button type="button" role="menuitem" data-sync="artifact" data-id="${esc(p.artifact_id)}">Open artifact</button>` : ""}
    ${
     canRemove
      ? `<div class="menu-sep" role="separator"></div>
         <button type="button" role="menuitem" class="danger" data-action="remove" data-id="${esc(p.id)}">Remove…</button>`
      : ""
    }
   </div>`;
 }

 function renderPickerDialog() {
  if (!pickerOpen) return "";
  const publishable = (state?.artifacts || []).filter((a) => a.kind === "page" || a.kind === "design");
  const q = pickerQuery.trim().toLowerCase();
  const filtered = q ? publishable.filter((a) => `${a.title} ${a.id}`.toLowerCase().includes(q)) : publishable;
  const pubsByArt = new Map((state?.publications || []).map((p) => [p.artifact_id, p]));

  return `<div class="dialog-backdrop" data-action="close-picker-backdrop">
   <div class="dialog-card" role="dialog" aria-modal="true" aria-labelledby="picker-title">
    <div class="panel-section row spread">
     <h2 id="picker-title">Choose an artifact to publish</h2>
     <button type="button" class="ghost" data-action="close-picker">Close</button>
    </div>
    ${
     publishable.length > 5
      ? `<div class="panel-section" style="padding-top:10px;padding-bottom:10px">
          <input id="picker-search" type="search" placeholder="Search pages and designs…" aria-label="Search pages and designs" value="${esc(pickerQuery)}" style="width:100%">
         </div>`
      : ""
    }
    <div class="picker-list">
     ${
      filtered.length > 0
       ? filtered
          .map((a) => {
           const pub = pubsByArt.get(a.id);
           return `<button type="button" class="picker-item" data-action="pick-artifact" data-id="${esc(a.id)}" data-version="${a.liveVersion || 1}">
            <span class="picker-item-main">
             <span class="picker-item-title">${esc(a.title || a.id)}</span>
             <span class="muted small">${esc(kindLabel(a.kind))} · v${a.liveVersion || 1}${pub && pub.status === "published" ? ` · Live on ${esc(pub.project)}.pages.dev` : ""}</span>
            </span>
            <span class="badge">${pub && pub.status === "published" ? "Update" : "Publish"}</span>
           </button>`;
          })
          .join("")
       : `<div class="panel-section"><p class="muted small">No matching page or design artifacts.</p></div>`
     }
    </div>
   </div>
  </div>`;
 }

 function render() {
  const active = document.activeElement;
  const focusId = active?.id;
  const selRange =
   active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA") && typeof active.selectionStart === "number"
    ? [active.selectionStart, active.selectionEnd]
    : null;

  root.setAttribute("aria-busy", String(Boolean(busy || reviewLoading || !state)));

  if (!state) {
   root.innerHTML = `<div class="shell">
    <header class="topbar"><h1>Sites</h1></header>
    ${
     error
      ? `<div class="state-box">
          <h2>Sites unavailable</h2>
          <p class="muted">${esc(error)}</p>
          <div class="row state-actions" data-align-row data-align-wrap>
           <button type="button" class="primary" data-action="refresh">Try again</button>
           <button type="button" data-sync="settings">Settings</button>
          </div>
         </div>`
      : `<div class="skeleton" aria-label="Loading sites"><div></div><div></div><div></div></div>`
    }
   </div>`;
   return;
  }

  const body = view === "review" ? renderReviewView() : view === "detail" ? renderDetailView() : renderListView();
  root.innerHTML = body + renderMenuOverlay() + renderPickerDialog();

  if (focusId) {
   const next = document.getElementById(focusId);
   if (next) {
    next.focus({ preventScroll: true });
    if (selRange && typeof next.setSelectionRange === "function") {
     try {
      next.setSelectionRange(selRange[0], selRange[1]);
     } catch {}
    }
   }
  }
 }

 async function refreshState() {
  try {
   state = await request("/state");
   if (state.error && !error) error = state.error;
   render();
  } catch (e) {
   error = e.message;
   render();
  }
 }

 async function openReview(artifactId, requestedVersion = 0, fromContext = false) {
  if (!artifactId) return;
  if (fromContext) originArtifactId = artifactId;
  const switchingArtifact = artifactId !== reviewArtifactId;
  reviewArtifactId = artifactId;
  reviewVersion = Number(requestedVersion) || 0;
  view = "review";
  pickerOpen = false;
  menuState = null;
  error = "";
  note = "";
  if (switchingArtifact) {
   projectTouched = false;
   justPublishedSiteId = "";
  }
  if (!isReady()) {
   reviewLoading = false;
   render();
   return;
  }
  const seq = ++reviewSeq;
  reviewLoading = true;
  render();
  try {
   const q = reviewVersion > 0 ? `?version=${reviewVersion}` : "";
   const data = await request(`/artifacts/${encodeURIComponent(artifactId)}/review${q}`);
   if (seq !== reviewSeq) return;
   reviewData = data;
   reviewVersion = data.selectedVersion;
   if (switchingArtifact || !projectTouched) {
    projectName = data.suggestedProject || "";
   }
   if (switchingArtifact) {
    const pub = data.publication;
    accessMode = pub?.access_mode || "public";
    accessEmails = (pub?.access_emails || []).join(", ");
    analyticsOn = pub?.hasProject ? Boolean(pub.analytics) : true;
   }
  } catch (e) {
   if (seq === reviewSeq) error = e.message;
  } finally {
   if (seq === reviewSeq) {
    reviewLoading = false;
    render();
   }
  }
 }

 // D2: Prepare and immediately open the host's immutable confirmation dialog.
 async function prepareAndConfirm(payload) {
  const op = await request("/prepare", payload);
  if (op.unchanged) {
   await refreshState();
   note =
    op.action === "analytics"
     ? "Web Analytics is already in that state."
     : "That version and access configuration are already live.";
   return null;
  }
  const res = await confirmDoor.operation(op.id);
  if (!res?.confirmed) {
   await request(`/operations/${encodeURIComponent(op.id)}/cancel`, {});
   await refreshState();
   return null;
  }
  await refreshState();
  return op;
 }

 async function dispatchAction(name, id = "", el = null) {
  if (name === "close-menu") {
   menuState = null;
   render();
   return;
  }
  if (name === "toggle-menu" && el) {
   if (menuState?.id === id) {
    menuState = null;
   } else {
    const rect = el.getBoundingClientRect();
    const width = 184;
    const height = 196;
    const x = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const y = rect.bottom + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 4) : rect.bottom + 4;
    menuState = { id, x, y };
   }
   render();
   return;
  }
  menuState = null;

  if (name === "nav-list") {
   view = "list";
   error = "";
   note = "";
   render();
   return;
  }
  if (name === "open-detail") {
   selectedSiteId = id;
   accessEditor = null;
   renameEditor = null;
   view = "detail";
   error = "";
   note = "";
   render();
   return;
  }
  if (name === "open-picker") {
   pickerOpen = true;
   pickerQuery = "";
   render();
   document.getElementById("picker-search")?.focus();
   return;
  }
  if (name === "close-picker" || name === "close-picker-backdrop") {
   pickerOpen = false;
   render();
   return;
  }
  if (name === "pick-artifact" || name === "open-review") {
   const ver = Number(el?.dataset?.version || 0);
   await openReview(id, ver, false);
   return;
  }
  if (name === "reload-review") {
   await openReview(reviewArtifactId, reviewVersion, false);
   return;
  }
  if (name === "set-filter") {
   filter = id;
   render();
   return;
  }
  if (name === "clear-filter") {
   filter = "all";
   search = "";
   render();
   return;
  }
  if (name === "review-access-mode") {
   accessMode = id;
   render();
   return;
  }
  if (name === "edit-access-mode" && accessEditor) {
   accessEditor.mode = id;
   render();
   return;
  }
  if (name === "access-edit") {
   const p = state?.publications?.find((item) => item.id === id);
   if (p) accessEditor = { id: p.id, mode: p.access_mode, emails: (p.access_emails || []).join(", ") };
   render();
   return;
  }
  if (name === "access-cancel") {
   accessEditor = null;
   render();
   return;
  }
  if (name === "rename-edit") {
   const p = state?.publications?.find((item) => item.id === id);
   if (p) renameEditor = { id: p.id, name: "" };
   render();
   document.getElementById("rename-name")?.focus();
   return;
  }
  if (name === "rename-cancel") {
   renameEditor = null;
   render();
   return;
  }

  if (busy) return;
  busy = name;
  error = "";
  note = "";
  render();
  try {
   if (name === "refresh") {
    await refreshState();
   } else if (name === "check-connection") {
    await request("/connection/check", {});
    await refreshState();
    if (view === "review" && reviewArtifactId && isReady()) {
     busy = "";
     await openReview(reviewArtifactId, reviewVersion, false);
     return;
    }
   } else if (name === "access-setup") {
    await request("/access/check", {});
    await refreshState();
   } else if (name === "access-verify") {
    await request("/access/verify", { publicationId: id });
    await refreshState();
    note = "Restricted access verified on production and preview links.";
   } else if (name === "publish") {
    const existing = state?.publications?.find(
     (p) => p.artifact_id === reviewArtifactId && p.hasProject && p.status !== "removed",
    );
    const parsed = publicationSchema.safeParse({
     artifactId: reviewArtifactId,
     version: reviewVersion,
     projectName: existing ? undefined : projectName.trim() || undefined,
    });
    if (!parsed.success) throw new Error(parsed.error.issues[0].message);
    const op = await prepareAndConfirm({
     ...parsed.data,
     access: parseAccess(accessMode, accessEmails),
     analytics: analyticsOn,
    });
    if (op) justPublishedSiteId = op.publication_id;
   } else if (name === "access-save" && accessEditor) {
    const op = await prepareAndConfirm({
     action: "access",
     publicationId: accessEditor.id,
     access: parseAccess(accessEditor.mode, accessEditor.emails),
    });
    if (op) accessEditor = null;
   } else if (name === "analytics-toggle") {
    const p = state?.publications?.find((item) => item.id === id);
    if (p) await prepareAndConfirm({ action: "analytics", publicationId: p.id, analytics: !p.analytics });
   } else if (name === "rename-save" && renameEditor) {
    const parsed = projectNameSchema.safeParse(renameEditor.name);
    if (!parsed.success) throw new Error(parsed.error.issues[0].message);
    const op = await prepareAndConfirm({
     action: "rename",
     publicationId: renameEditor.id,
     projectName: parsed.data,
    });
    if (op) renameEditor = null;
   } else if (name === "remove") {
    await prepareAndConfirm({ action: "remove", publicationId: id });
   } else if (name === "restore") {
    const [publicationId, deployment] = id.split("/");
    await prepareAndConfirm({ action: "rollback", publicationId, deployment });
   } else if (name === "undo-restore") {
    const ver = Number(el?.dataset?.version || 0);
    await prepareAndConfirm({ action: "rollback", publicationId: id, version: ver });
   } else if (name === "confirm-op") {
    await confirmDoor.operation(id);
    await refreshState();
   } else if (name === "cancel-op") {
    await request(`/operations/${encodeURIComponent(id)}/cancel`, {});
    await refreshState();
   } else if (name === "check-op") {
    await request(`/operations/${encodeURIComponent(id)}/check`, {});
    await refreshState();
   }
  } catch (e) {
   error = e.message;
  } finally {
   busy = "";
   render();
  }
 }

 root.addEventListener("input", (e) => {
  const t = e.target;
  if (t.id === "project-name") {
   projectName = t.value;
   projectTouched = true;
  } else if (t.id === "review-access-emails") {
   accessEmails = t.value;
  } else if (t.id === "edit-access-emails" && accessEditor) {
   accessEditor.emails = t.value;
  } else if (t.id === "rename-name" && renameEditor) {
   renameEditor.name = t.value;
  } else if (t.id === "site-search") {
   search = t.value;
   render();
  } else if (t.id === "picker-search") {
   pickerQuery = t.value;
   render();
  }
 });

 root.addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === "review-version") {
   void openReview(reviewArtifactId, Number(t.value), false);
  } else if (t.id === "review-analytics") {
   analyticsOn = Boolean(t.checked);
  }
 });

 root.addEventListener("submit", (e) => {
  e.preventDefault();
  if (e.target.id === "review-form") void dispatchAction("publish");
  else if (e.target.id === "access-form") void dispatchAction("access-save");
  else if (e.target.id === "rename-form") void dispatchAction("rename-save");
 });

 root.addEventListener("click", (e) => {
  if (e.target.classList?.contains("dialog-backdrop")) {
   pickerOpen = false;
   render();
   return;
  }
  const syncBtn = e.target.closest("[data-sync]");
  if (syncBtn) {
   e.preventDefault();
   menuState = null;
   const kind = syncBtn.dataset.sync;
   if (kind === "settings") void goSettings();
   else if (kind === "artifact") void goArtifact(syncBtn.dataset.id);
   else if (kind === "agent") void goAgent(syncBtn.dataset.id);
   else if (kind === "open-url") void openExternal(syncBtn.dataset.url);
   else if (kind === "copy") copyText(syncBtn.dataset.url, syncBtn.dataset.key || "url");
   else if (kind === "create-token") {
    const url = state?.tokenUrl || "https://dash.cloudflare.com/profile/api-tokens";
    tokenStepOpened = true;
    void openExternal(url);
    render();
   } else {
    render();
   }
   return;
  }
  const btn = e.target.closest("[data-action]");
  if (btn) {
   e.preventDefault();
   void dispatchAction(btn.dataset.action, btn.dataset.id || "", btn);
  }
 });

 document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
   if (menuState) {
    menuState = null;
    render();
   } else if (pickerOpen) {
    pickerOpen = false;
    render();
   }
  }
 });

 if (events) {
  events.onChange(() => {
   clearTimeout(refreshTimer);
   refreshTimer = setTimeout(async () => {
    await refreshState();
    if (view === "review" && reviewArtifactId && justPublishedSiteId === "") {
     const pub = state?.publications?.find((p) => p.artifact_id === reviewArtifactId);
     if (pub && pub.status === "published" && pub.version === reviewVersion) {
      justPublishedSiteId = pub.id;
      render();
     }
    }
   }, 120);
  });
 }

 const initialCtx = context?.current?.() || null;
 if (initialCtx?.artifactId) {
  originArtifactId = initialCtx.artifactId;
  reviewArtifactId = initialCtx.artifactId;
  reviewVersion = Number(initialCtx.version) || 0;
  view = "review";
 }
 if (context?.onChange) {
  context.onChange((c) => {
   if (c?.artifactId) {
    void openReview(c.artifactId, Number(c.version) || 0, true);
   }
  });
 }

 await refreshState();
 if (view === "review" && reviewArtifactId) {
  await openReview(reviewArtifactId, reviewVersion, true);
 }
})().catch(() => {
 const root = document.getElementById("root");
 root.setAttribute("aria-busy", "false");
 root.innerHTML = `<div class="shell"><div class="state-box"><h2>Sites could not start</h2><p class="muted">Reopen Sites from Extensions or reload this tab.</p></div></div>`;
});
