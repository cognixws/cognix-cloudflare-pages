# Changelog

## 0.6.0

Phase F2 of the v2 plan (D4, D5, D6, D10 as recommended; owner approval 2026-11-26). No COGNIX[WS] core change: same `apiVersion` 26, same permissions, same doors.

- **Custom domains (D6)**: **Manage site › Custom domains › Add domain…** adds a subdomain (such as `docs.example.com`) to the site's Pages project first (a CNAME that exists before the domain answers 522), then creates its proxied CNAME when the domain's zone is in the same Cloudflare account and the token may edit its DNS (`Zone › DNS: Edit`, optional). Otherwise the site shows the exact record to add (each cell copies on click). States: **Active**, **Waiting for DNS** (checked every minute and by **Check now**, which also retries a failed validation), **Needs attention**. Whole domains (apex), reserved names, a name with another record, and restricted sites are refused with the reason. Removing a domain, or the site, deletes the CNAME records Sites created first (only if they still read as written) and tells the person which records at other DNS providers to delete, so no name is left pointing at a `pages.dev` address another account could claim. **Change address** is refused while a site has custom domains; a site with custom domains cannot become restricted.
- **7-day Visits and Page views (D5)**: the sites list shows a 7-day visits column with daily bars; **Manage site › Web Analytics** shows Visits, Page views and the days. One GraphQL Analytics query (`rumPageloadEventsAdaptiveGroups`) covers every site of the account, cached in SQLite and refreshed at most every 30 minutes (Refresh: once a minute). A token without **Account Analytics: Read** never fails the page: Sites says what to add, and the settings check and Check connection report it without blocking a save. Cookie-free Web Analytics counts visits, never visitors.
- **Keep up to date (D4)**: off by default; turned on per site through COGNIX[WS]'s confirmation (which names a newer version that will be published at once). Each new live version of the artifact is then published with the site's access and settings, as actor "Keep up to date". It never publishes over a version this computer did not publish (it turns off and says why), waits while the token is refused or restricted access is not ready (one Inbox note per reason), does not retry a version Cloudflare or the packager refused (one note; **Try again**), and turns off when a person or an agent restores or publishes an older version. `outsideEffects: true` keeps it on one of the person's synced computers. Agents cannot turn it on (D3).
- **Each version keeps its own link (D10)**: Manage site › Versions shows each version's deployment link with **Copy link**, and **Delete link…** on a version that is not live (confirmed; Restore then re-uploads it from COGNIX[WS]).
- Agent `status` reports `keepUpToDate` and active `customDomains`; a `restore` that turns Keep up to date off says so. No new agent tool.
- The sites list's columns now line up whatever actions a row shows (a fixed Actions column); below 900px it stacks.
- UI copy is English: the extension has no translations and COGNIX[WS] does not give extension pages the host's language.

## 0.5.1

- **One primary action per site state**: the review and **Manage site** take their buttons from one tested rule (`ui/actions.mjs`; table in `docs/acceptance.md`). Fixes three defects from the 2026-11-23 real-account pilot:
  - **Publish vN** no longer stays enabled when version N is already live: **Open site** leads, and **Publish vN** returns only when the access or Web Analytics choice in the form differs from the site.
  - After a restore, **Undo to vN** is the one action for the replaced version; **Publish vN** no longer sits beside it (also in the sites list, which showed **Update vN**, and in the version history, which no longer offers **Restore** on the live version or on the Undo version).
  - A removed site offers **Publish again as a new site…** (review: **Publish vN as a new site**), and the confirmation reads "Publish version N as a new site?", naming the removed address; this holds after a cancelled republication too.
- A restricted site whose Access setup is not ready holds the change with the reason in text and **Open settings** (or **Check setup** when only a check is missing), instead of failing on confirm: a publish is held on the form's access, **Undo** and history **Restore** on the site's.
- The review form starts from the site's own access and Web Analytics on every review until it is edited, so a choice left over from an earlier review is never shown as a change.
- With an operation prepared, Enter in the review no longer tries to publish.
- Enter in the review form submits only when the primary action is a publish.

## 0.5.0

- **Focused artifact review (D1c & D2)**: `⋯ → Publish to Cloudflare Pages…` appears only on `page` and `design` artifacts (`apiVersion: 26` `artifactKinds`), opens **Sites** directly on the artifact's review with one-click **← Back to artifact** (`places.artifact`), and opens COGNIX[WS]'s confirmation dialog directly on **Publish vN**.
- **Agent publishing tools (D3)**: add `picode-tools/1` capability `pages` (`sites`, `publish`, `status`, `restore`) with bounded output and non-blocking **Updates** FYI notes in Inbox; keep site removal, access and reader changes on existing sites and address renames owner-only. Agents act only on artifacts of their own workspace, and a failed agent publish or restore also leaves an FYI.
- **Short `.pages.dev` slugs (D7)**: generate readable title slugs for new sites with automatic short suffixes on collision.
- **Guided token setup & Reconnect (D8 & D13)**: add pre-filled Cloudflare API token link with exact dashboard permission labels, verify credentials on save (`process.settingsCheck`; a refused optional Access token no longer blocks saving the main token, and `Sites` names it), show **Reconnect** on 401/403 or after `data.db` backup restore, and isolate rows across Cloudflare `account_id` switches.
- **Restore fallback & >100 deploy cleanup (D10)**: fall back to re-uploading the immutable local COGNIX[WS] artifact version when Cloudflare pruned an older deployment, keep one-click **Undo** after Restore, and batch-prune non-canonical deployments before deleting projects with >100 deployments.
- **Public notice, non-blocking key scan & clear refusals (D11 & D12)**: support `design` artifacts alongside `page`, warn without blocking when text files match common key prefixes anywhere in the file, minified or large ones included (`warnings[]` on agent `publish`, public or restricted), and guide standalone versions via `places.agent` when a version declares workspace capabilities.

## 0.4.1

- Removed sites stay hidden behind a "Show removed" toggle and render muted.

## 0.4.0

- Add Web Analytics: enabled from the publish form or Site settings, with a View analytics link into the project's dashboard analytics.
- Add Change address: publish the current version to a new project name, verify it, then retire the old address and its deployment URLs.
- The connection check reports Web Analytics capability; it needs Account Settings Read and Write on the token.
- Removal now also deletes the site's Web Analytics entry; a lost delete holds with Check result.

## 0.3.0

- Add Public and Restricted by exact email, using Cloudflare Access and email codes.
- Protect production, previews/aliases and custom domains before upload; verify policies and anonymous access.
- Change readers independently of artifact versions, revoke sessions, preserve access on updates/restores and confirm Public changes explicitly.
- Keep existing sites Public on upgrade; hold uncertain Access effects without repeating writes.


## 0.2.1

- Use Cloudflare’s official application icon in the extension and as the Publications favicon.

## 0.2.0

- Organize publishing around the selected artifact, public version and site history.
- Add an explicit account-access check; saved settings no longer imply a verified connection.
- Preserve operation progress and recovery, and remove dead links after site removal.
- Keep setup and error states actionable on desktop and mobile.

Validation: 19 automated tests and scratch browser lifecycle QA with a simulated
Cloudflare provider. Production Cloudflare and native-device acceptance remain open.
