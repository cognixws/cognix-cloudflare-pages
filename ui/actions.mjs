// Which action leads in each state of a site (0.5.1). One rule, used by the
// review view and by Manage site; the table it implements is in
// docs/acceptance.md ("0.5.1 primary action table"), and every row is tested in
// test/primary-action.test.mjs.
//
// Kinds:
//  publish        Publish vN (review: prepares + host confirm; manage: opens the review)
//  new-site       publish to a new site after the old one was removed
//  undo           switch back to the version that was live before a restore
//  open-site      open the live address
//  copy-link      copy the live address
//  settings       open the extension settings
//  none           no primary action (another account, an operation in progress)

function emailsKey(list) {
 return [...new Set((list || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))].sort().join(",");
}

// The review form holds access and analytics choices; they differ from the
// site when publishing the same version would still change something.
export function formDiffers(pub, form) {
 if (!pub || !form) return false;
 const mode = form.mode || "public";
 if (mode !== (pub.access_mode || "public")) return true;
 if (mode === "restricted" && emailsKey(form.emails) !== emailsKey(pub.access_emails)) return true;
 if (form.analytics !== undefined && Boolean(form.analytics) !== Boolean(pub.analytics)) return true;
 return false;
}

export function siteState(pub) {
 if (!pub) return "new";
 if (pub.otherAccount) return "other-account";
 if (pub.status === "removed") return "removed";
 // A removed site whose republication was prepared and cancelled has no
 // project but keeps its history: publishing still creates a new site.
 if (!pub.hasProject && pub.history?.length && pub.status !== "published") return "removed";
 if (pub.status === "published" && pub.hasProject && pub.version) {
  return pub.undoVersion ? "restored" : "live";
 }
 return "new";
}

/**
 * @param {object} o
 * @param {"review"|"manage"} o.surface
 * @param {object|null} o.pub serialized publication (or null for an artifact never published)
 * @param {number} o.selected the version in view: the review's selected version, Manage site's latest
 * @param {{mode:string,emails:string[],analytics?:boolean}|null} [o.form] the review form's choices
 * @param {boolean} o.accessReady Cloudflare Access setup is ready
 * @param {boolean} [o.accessSettings] Access needs a token or other settings (not only a check)
 * @param {boolean} [o.blocked] an operation is prepared, running or needs a check, or the
 *   Cloudflare connection is not ready: nothing may change, the live links stay
 */
export function siteActions({ surface, pub, selected, form = null, accessReady, accessSettings = true, blocked = false }) {
 const state = siteState(pub);
 const live = pub?.version || 0;
 const undo = pub?.undoVersion || 0;
 const changed = formDiffers(pub, form);
 // A publish uses the form's access; Undo keeps the site's (prepare sends none).
 const formMode = form?.mode || pub?.access_mode || "public";
 const siteMode = pub?.access_mode || "public";
 const out = { state, primary: { kind: "none", label: "", enabled: false }, secondary: [], sentence: "" };
 const manage = surface === "manage";
 const openSite = { kind: "open-site", label: "Open site" };
 const copyLink = { kind: "copy-link", label: "Copy link" };
 const liveLinks = manage ? [copyLink, openSite] : [];

 if (state === "other-account" || blocked) {
  if (manage && pub?.url && pub.status !== "removed") out.secondary = liveLinks;
  return out;
 }
 // No local version to publish (the artifact was deleted): only the live links.
 if (!selected) {
  if (state === "live" || state === "restored") {
   out.primary = { ...openSite, enabled: true };
   out.secondary = manage ? [copyLink] : [];
   out.sentence = `Version ${live} is currently published.`;
  }
  return out;
 }

 if (state === "removed") {
  out.primary = manage
   ? { kind: "new-site", label: "Publish again as a new site…", version: selected, enabled: true }
   : { kind: "new-site", label: `Publish v${selected} as a new site`, version: selected, enabled: true };
  out.sentence = manage
   ? "This site was removed; publishing again creates a new site."
   : "The earlier site was removed; publishing creates a new site at the address above.";
 } else if (state === "new") {
  out.primary = { kind: "publish", label: `Publish v${selected}`, version: selected, enabled: true };
  out.sentence = "";
 } else if (selected === live && !changed) {
  out.primary = { ...openSite, enabled: true };
  out.secondary = manage ? [copyLink] : [];
  if (undo && undo !== live) out.secondary.push({ kind: "undo", label: `Undo to v${undo}`, version: undo });
  out.sentence = `Version ${live} is currently published.`;
 } else if (state === "restored" && selected === undo && !changed) {
  out.primary = { kind: "undo", label: `Undo to v${undo}`, version: undo, enabled: true };
  out.secondary = liveLinks;
  out.sentence = `Version ${live} was restored; Undo switches the site back to version ${undo}.`;
 } else {
  out.primary = { kind: "publish", label: `Publish v${selected}`, version: selected, enabled: true };
  out.secondary = [...liveLinks];
  if (undo && undo !== selected && undo !== live) out.secondary.push({ kind: "undo", label: `Undo to v${undo}`, version: undo });
  out.sentence =
   selected === live
    ? `Version ${live} is live; publishing it again applies the changed settings.`
    : `Version ${live} is live; publishing replaces it with version ${selected}.`;
 }

 // Restricted pending setup: a change to a restricted site waits for Access.
 // In Manage site a new or removed site's button only opens the review, where
 // the access choice is made again, so it is not held there.
 const mutating = ["publish", "new-site", "undo"];
 const choosesAgain = manage && (state === "new" || state === "removed");
 const held = (a) =>
  !accessReady && !choosesAgain && mutating.includes(a.kind) && (a.kind === "undo" ? siteMode : formMode) === "restricted";
 if (held(out.primary)) {
  out.primary = { ...out.primary, enabled: false };
  out.sentence = accessSettings
   ? "Restricted access needs setup before this site can change."
   : "Cloudflare Access is not verified yet; check it before this site can change.";
  // The review's access field shows its own setup banner when the form is restricted.
  if (manage || formMode !== "restricted") {
   out.secondary.push(accessSettings ? { kind: "settings", label: "Open settings" } : { kind: "check-setup", label: "Check setup" });
  }
 }
 out.secondary = out.secondary.filter((a) => !held(a));
 return out;
}

// A history row offers Restore only for a version that is neither live (a
// no-op) nor the one Undo already switches back to (two actions for one thing),
// and not while a restricted site waits for Access setup (it would fail).
export function restoreOffered(pub, rowVersion, accessReady = true) {
 if (!pub || pub.status !== "published") return false;
 if (pub.access_mode === "restricted" && !accessReady) return false;
 if (rowVersion === pub.version) return false;
 if (pub.undoVersion && rowVersion === pub.undoVersion) return false;
 return true;
}

const esc = (v) =>
 String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// The buttons of siteActions(): secondaries first, the primary last. In the
// review a publish is the form's submit; in Manage site it opens the review.
export function actionButtonsHTML(actions, pub, { surface = "review", busy = "", copiedKey = "" } = {}) {
 const button = (a, primary) => {
  const cls = primary ? ` class="primary"` : "";
  const off = busy || (primary && !a.enabled) ? " disabled" : "";
  if (a.kind === "publish" || a.kind === "new-site") {
   if (surface === "review") return `<button type="submit"${cls}${off}>${busy === "publish" ? "Preparing…" : esc(a.label)}</button>`;
   return `<button type="button"${cls} data-action="open-review" data-id="${esc(pub.artifact_id)}" data-version="${a.version}"${off}>${esc(a.label)}</button>`;
  }
  if (a.kind === "undo") {
   return `<button type="button"${cls} data-action="undo-restore" data-id="${esc(pub.id)}" data-version="${a.version}"${off}>${busy === "undo-restore" ? "Preparing…" : esc(a.label)}</button>`;
  }
  if (a.kind === "open-site") return `<button type="button"${cls} data-sync="open-url" data-url="${esc(pub.url)}">${esc(a.label)}</button>`;
  if (a.kind === "copy-link") {
   const key = `${surface}-${pub.id}`;
   return `<button type="button"${cls} data-sync="copy" data-url="${esc(pub.url)}" data-key="${esc(key)}">${copiedKey === key ? "Copied" : esc(a.label)}</button>`;
  }
  if (a.kind === "settings") return `<button type="button"${cls} data-sync="settings">${esc(a.label)}</button>`;
  if (a.kind === "check-setup") return `<button type="button"${cls} data-action="access-setup"${busy ? " disabled" : ""}>${busy === "access-setup" ? "Checking…" : esc(a.label)}</button>`;
  return "";
 };
 return [...actions.secondary.map((a) => button(a, false)), actions.primary.kind === "none" ? "" : button(actions.primary, true)].join("\n");
}

// The review form's starting choices: the site's own, or the defaults for a new one.
export function seedForm(pub) {
 return {
  mode: pub?.access_mode || "public",
  emails: (pub?.access_emails || []).join(", "),
  analytics: pub?.hasProject && pub.status !== "removed" ? Boolean(pub.analytics) : true,
 };
}
