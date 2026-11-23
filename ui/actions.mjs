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
 * @param {boolean} [o.blocked] an operation is prepared, running or needs a check, or the
 *   Cloudflare connection is not ready: nothing may change, the live links stay
 */
export function siteActions({ surface, pub, selected, form = null, accessReady, blocked = false }) {
 const state = siteState(pub);
 const live = pub?.version || 0;
 const undo = pub?.undoVersion || 0;
 const changed = formDiffers(pub, form);
 const mode = form?.mode || pub?.access_mode || "public";
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
   ? "This site was removed; publishing again creates a new site at a new address."
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
 if (mode === "restricted" && !accessReady && !choosesAgain) {
  if (mutating.includes(out.primary.kind)) {
   out.primary = { ...out.primary, enabled: false };
   out.sentence = "Restricted access needs setup before this site can change.";
   if (manage) out.secondary.push({ kind: "settings", label: "Open settings" });
  }
  out.secondary = out.secondary.filter((a) => !mutating.includes(a.kind));
 }
 return out;
}
