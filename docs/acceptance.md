# Publication decision table and acceptance

This document tracks automated fake-provider / scratch-browser verification versus real-account and native-device acceptance debts across releases.

## 0.6.0 (Phase F2) decision tables

All evidence below is automated against `test/fake-cloudflare.mjs` (loopback,
no account, no token) in `test/v2-f2.test.mjs`, plus scratch screenshots of
the real UI against the same fake (desktop 1280px and phone 390px, dark and
light). The live owner pilot is still to come (open debts below).

### Keep up to date × synced computers × artifact change × token permissions

"This computer" is the computer COGNIX[WS] runs the extension on: with
`outsideEffects: true` the host starts the process on one of the person's
synced computers only (`ExtensionRunsHere`; host proof
`TestExtensionWithOutsideEffectsRunsOnOneComputer`). Each computer keeps its
own `data.db`, so the extension adds its own guard for a computer whose records
are stale (row 5). A round runs once a minute and when Sites nudges it.

| # | Keep up to date | Synced computers | Artifact change | Token permissions | Outcome | Evidence |
|---|---|---|---|---|---|---|
| 1 | Off (default) | any | new live version N | any | Nothing published; the site shows Update ready (vN) | `D4 row 1` |
| 2 | On | this computer runs the extension | new live version N, a standalone page or design | Pages: Edit | Publishes vN without asking (actor "Keep up to date"), keeping the site's access, readers, Web Analytics and domains; no Inbox note | `D4 rows 2 and 17` |
| 3 | On | this computer | none (latest = live) | any | Nothing | `D4 rows 2 and 17` |
| 4 | On | another computer runs the extension | any | any | The process does not run here; nothing happens on this computer | host rule (`outsideEffects`), manifest asserted in `test/package.test.mjs` |
| 5 | On | the process moved to a computer whose records are stale (Cloudflare's production deployment is not the one recorded here) | new version | Pages: Edit | Turns off with the reason; one Inbox note; publishes nothing over the other computer's work | `D4 row 5` |
| 6 | On | this computer | new version declares workspace capabilities, is another kind, or has no static entry | Pages: Edit | Not published; one note for that version; not retried on its own; a newer good version (automatic or by hand) settles the note; Try again retries | `D4 row 6`, `review 6` |
| 6b | On | this computer | new version | Pages: Edit, but the connection drops or Cloudflare answers 5xx/429 mid-publish | Not recorded as refused; one "tries again" note; the next round retries, and repeated failures wait 2, 4 … 60 minutes (in memory, reset on restart) | `review 4`, `review N3` |
| 6c | On | this computer | the person turns it off while a round prepares | any | The prepared publish is cancelled, never confirmed | `review 5` |
| 7 | On | this computer | new version | token refused (401/403), before or during the upload | Paused; Sites shows the token banner; one note per waiting version; the version is not recorded as refused; resumes when the token is checked again | `D4 row 7`, `review 4b` |
| 8 | On | this computer | new version | no Account Analytics: Read | Publishes normally; only visits say what is missing | `D4 row 8` |
| 9 | On | this computer | new version | no Account Settings: Edit, Web Analytics already configured on the site | Publishes (the configured beacon needs no new write); if Web Analytics was cleared outside Sites, the publish fails and row 12 applies | covered by 0.4.0 `test/analytics.test.mjs` + row 12 |
| 10 | On | this computer | new version of a restricted site | Access token missing or Access not ready | Waits; one note; publishes once Access is ready (just after a restart, before Access is checked, it waits without a note) | `D4 row 10` |
| 11 | On | this computer | new version while an operation on the site is prepared, running or held | any | Waits for the next round | `D4 row 11` |
| 12 | On | this computer | new version | Pages: Edit, but Cloudflare refuses the deployment | The site keeps its version; one note; not retried on its own; Try again | `D4 row 12` |
| 13 | On | this computer | a person or an agent restores any version, or publishes a version older than the latest | any | Turns off in the same transaction as the new version, decided when the change is prepared (no second read of the artifact); the confirmation and the agent's `restore` or `publish` answer say so; the round never undoes it | `D4 row 13`, `review 2` |
| 14 | On | this computer | the site is removed | any | Turned off with the removal | `D4 rows 14 and 15` |
| 15 | On | this computer | new version of a site in another Cloudflare account (account switched) | other account's token | Not followed | `D4 rows 14 and 15` |
| 16 | On | this computer | new version; Cloudflare's answer to the deployment is lost | Pages: Edit | Held at Check result with one note; no second deployment; Check result settles it by the deployment marker | `D4 row 16` |
| 17 | Turning it on | this computer | a newer version is already waiting | Pages: Edit | COGNIX[WS]'s confirmation names that version; it is published right after | `D4 rows 2 and 17` |
| 18 | Agent | any | any | any | No tool turns it on (D3); `status` reports it | `D4 row 13` |

### Custom domains (D6)

| Conditions | Action | Evidence |
|---|---|---|
| Subdomain, zone in this account, token reads zones and edits DNS | Pages domain first, then a proxied CNAME to `<site>.pages.dev` (comment names the operation); Check now reads Active | `D6 zone in this account` |
| Subdomain at another DNS provider | Pages domain only; the exact CNAME is shown with copyable cells; the background round reads Active | `D6 external DNS` |
| Zone not readable | Falls back to the record to add; the confirmation says the token cannot edit that DNS | `D6 without DNS permission` |
| Zone readable, DNS not writable | The confirmation says Sites creates the record when the token may edit its DNS, otherwise shows it; it ends showing the record | `D6 without DNS permission` |
| The token loses DNS permission after Sites created a record | Domain or site removal still finishes; the record is left, named in the operation's warnings and one Inbox note (also after a lost answer and Check result); the main token is not marked refused | `review 1`, `review N1` |
| Two changes to the same name at once | The second is refused in words (409) | `review 9` |
| Whole domain (two labels, or a name that is its own zone), reserved names, invalid names | Refused before any effect | `D6 refusals` |
| The name already has another DNS record | Refused; Sites never replaces a record it did not create | `D6 refusals` |
| The name is on this or another of the sites | Refused | `D6 refusals` |
| Restricted site; making a site with domains restricted; Change address with domains | Refused with the reason | `D6 refusals` |
| Remove a domain | CNAME (if Sites created it and it is unchanged) deleted before the domain; a changed record is left and said so | `D6 removing a domain` |
| Remove the site | Sites' CNAME records deleted before the project (phase `dns`, safe to repeat); the confirmation names records at other providers to delete | `D6 removing the site`, `review 10` (lost answer in the DNS step: Check result finishes, one project delete) |
| Lost answer on the domain add | Held; Check result reads the name back: one domain, one record | `D6 a lost answer` |
| Lost answer, then Cloudflare refuses the name on Check result | Fails, the local row goes, the site is free again | `review 3` |
| Real zone, real validation, certificate issuance, CAA | Not exercised | owner pilot (debt) |

### Visits (D5)

| Conditions | Action | Evidence |
|---|---|---|
| Sites with Web Analytics on | One GraphQL query for all their site tags, 7 zero-filled days per site, Visits and Page views, cached in SQLite | `D5 visits` |
| Cache younger than 30 minutes; Refresh within a minute | No query | `D5 visits` |
| Token without Account Analytics: Read | Settings save and Check connection succeed and name it; Sites shows the sentence with Create a token / Open settings; publishing unaffected | `D5 a token without Account Analytics: Read`, `D4 row 8` |
| Untrusted values in the query | Account, tags and dates validated before they are written into the query | `D5 the query is built from validated values only` |
| Real `rumPageloadEventsAdaptiveGroups` fields (`count`, `sum.visits`, `dimensions.date/siteTag`, `siteTag_in`, `date_geq/leq`) | Not verified live | owner pilot (debt) |

### Version links (D10)

| Conditions | Action | Evidence |
|---|---|---|
| A version that is not live | Copy link; Delete link… (danger confirmation names the URL); absence verified; the row reads "Link deleted; restores from COGNIX[WS]" | `D10 each version keeps its own link` |
| The live version | Delete refused | `D10` |
| Restore after deletion | Re-uploads the immutable local version | `D10` |

### Open acceptance debts (0.6.0)

- **Owner pilot of 0.6.0** on the owner's account and one of the owner's domains: add a subdomain in a zone of the account (CNAME created, Active, Open), add one at an external provider (record shown, Active after DNS), Remove domain (CNAME deleted first), remove a site with a domain; 7-day visits on a site with traffic (the GraphQL field names) and with a token lacking Account Analytics: Read; Keep up to date on, publish a new artifact version, check the site follows; restore an older version and check it turns off; Delete link on an old version.
- **Synced computers**: the stale-records guard (row 5) is tested; moving the extension between two real synced computers with Keep up to date on is not.

## 0.5.1 primary action table

Which action leads in each state of a site. One rule, `siteActions()` in
`ui/actions.mjs`, renders the review footer (selected version = the version
picker) and the header of **Manage site** (selected version = the artifact's
latest); the sites list row offers its primary only when it is **Update vN** or
**Undo to vN**. The owner saw rows 2, 5 and 8 wrong in the 2026-11-23 pilot.
Secondary actions are listed in the order shown, before the primary. "Form
changed" means the review's access or Web Analytics choice differs from the
site's. Every row is a test in `test/primary-action.test.mjs`, and the buttons are
rendered by one pure function (`actionButtonsHTML()`), tested for rows 2, 5, 8
and 9. The review form starts from the site's own access and Web Analytics on
every review until the person edits it, so a choice left over from an earlier
review is never presented as a change.

Known limit (row 2): when the live version and settings match, no Publish is
offered. If the site was deployed from outside the extension (the canonical
deployment drifted), the way back is a Restore of another history row, or
Cloudflare itself; the extension does not offer a re-push of the same version.

| # | Site state | Selected version | Primary (words) | Enabled | Secondary (review / Manage site) | Sentence |
|---|---|---|---|---|---|---|
| 1 | New (never published, or a draft without a project) | any N | Publish vN | yes | — / — | Publishes to Cloudflare account … |
| 2 | Live at latest | N = live, form unchanged | Open site | yes | — / Copy link | Version N is currently published. |
| 3 | Live | N = live, form changed | Publish vN | yes | — / Copy link, Open site | Version N is live; publishing it again applies the changed settings. |
| 4 | Live at older (no restore) | N ≠ live | Publish vN | yes | — / Copy link, Open site | Version L is live; publishing replaces it with version N. |
| 5 | Live at older after restore (undo U) | N = U, form unchanged | Undo to vU | yes | — / Copy link, Open site | Version L was restored; Undo switches the site back to version U. |
| 5b | History list (Manage site › Versions) | each row's version | Restore only for a version that is neither live nor the Undo version, and not on a restricted site while Access setup is not ready (`restoreOffered()`) | — | — | — |
| 6 | Live at older after restore | N = live | Open site | yes | Undo to vU / Copy link, Undo to vU | Version L is currently published. |
| 7 | Live at older after restore | N ≠ live, N ≠ U | Publish vN | yes | Undo to vU / Copy link, Open site, Undo to vU | Version L is live; publishing replaces it with version N. |
| 8 | Removed (also after a cancelled republication: no project, history kept) | latest N | Review: Publish vN as a new site · Manage site: Publish again as a new site… (opens the review) | yes | — / — (no links to a removed address) | Review: The earlier site was removed; publishing creates a new site at the address above. Manage site: This site was removed; publishing again creates a new site. Host confirm: "Publish version N as a new site?", "<old>.pages.dev was removed, so this creates a new site: …", button "Publish new site". |
| 8b | Removed, artifact deleted locally | none | — | — | — | — |
| 9 | Restricted pending setup (Access setup not ready; a publish is held on the form's access, Undo and history Restore on the site's, since a rollback keeps the site's access) | rows 3, 4, 5, 7 | the same words | no | held Undo hidden; adds Open settings when Access needs a token or settings, Check setup when it only needs a check (review: only when the form is public, since the access field shows its own setup banner otherwise) | Restricted access needs setup before this site can change. / Cloudflare Access is not verified yet; check it before this site can change. Rows 2 and 6 keep Open site; Manage site of a new or removed site only opens the review and is not held. |
| 10 | Other account, an operation prepared / running / to check (review too: Enter does nothing), or no connection | any | none (the operation's own Confirm, Cancel or Check result leads) | — | Manage site keeps Copy link, Open site | — |

## v0.5.0 (Phase F1) decision table: token state × deployment state × artifact kind → action

| Token state | Deployment state | Artifact kind / capabilities | Operation | Expected outcome | Evidence |
|---|---|---|---|---|---|
| Missing (`not-configured`) | New (0 sites) | `page` or `design` | Review / `publish` | Blocked state (`Cloudflare account not connected` → pre-filled token URL); no remote call | `test/v2-f1.test.mjs`, scratch QA |
| Missing after backup restore (`data.db` has sites, `secrets.json` empty) | Live site in DB | `page` or `design` | Open `Sites` / `publish` | `Reconnect Cloudflare` banner (`status: "reconnect"`); existing history preserved | `test/v2-f1.test.mjs`, scratch QA |
| Expired / 401 / 403 | New or Live | `page` or `design` | Prepare / `publish` / `restore` | Marks connection `expired`, surfaces `Update token` banner; live sites untouched | `test/v2-f1.test.mjs`, scratch QA |
| Valid, different `account_id` | Live in other account | `page` or `design` | Open `Sites` / Review / Agent `sites` | Marked `Other account` read-only; hidden from agent `sites`; mutation refused until account switched | `test/v2-f1.test.mjs`, scratch QA |
| Valid | New | `page` | Owner or Agent `publish` | Short slug `<title>.pages.dev` (D7), Direct Upload (D9), `Live` | `test/v2-f1.test.mjs`, scratch QA |
| Valid | New | `design` | Owner or Agent `publish` | Exported multi-artboard static bundle uploaded to `<title>.pages.dev`, `Live` | `test/v2-f1.test.mjs`, scratch QA |
| Valid | New | `page` with key-like string (`cfut_…`, `sk-…`) | Review / Agent `publish` | Non-blocking warning (`Inspect artifact` secondary, `Publish vN` primary; `warnings[]` on tool), raw secret never echoed | `test/v2-f1.test.mjs`, scratch QA |
| Valid | New | `page` declaring `state`/`files`/`picode` | Open Review / Agent `publish` | Refused (`Version N uses COGNIX[WS] data` + `Ask <Agent> for a standalone version`) | `test/v2-f1.test.mjs`, scratch QA |
| Valid | New | `document` / `dashboard` / `design-system` | Artifact `⋯` menu / Direct review | Hidden from `⋯` by `C1c` (`artifactKinds: ["page","design"]`); graceful `Only pages and designs publish as sites` on direct open | `places_manifest_test.go`, `extensions.test.js`, `test/v2-f1.test.mjs`, scratch QA |
| Valid | Live (target deployment active on Cloudflare) | `page` or `design` | Owner or Agent `restore` | Instant Cloudflare `/rollback`, records `undoVersion` | `test/v2-f1.test.mjs` |
| Valid | Live (target deployment pruned 404 on Cloudflare) | `page` or `design` | Owner or Agent `restore` | Re-uploads immutable local COGNIX[WS] artifact version via Direct Upload, marks deployment pruned, records `undoVersion` | `test/v2-f1.test.mjs`, scratch QA |
| Valid | Live (>100 deployments on project) | `page` or `design` | Owner `Remove…` | Batch-prunes non-canonical deployments before `DELETE /projects/{name}` | `test/v2-f1.test.mjs` |
| Valid | Live (`restricted` access) | `page` or `design` | Agent `publish` with `access: "public"` or `projectName` rename or `remove` | Refused; human-only in `Sites` with owner confirmation | `test/v2-f1.test.mjs` |
| Valid | Live (any access) | `page` or `design` | Agent `publish` changing `access` or `emails` of an existing site | Refused; a new version keeps the site's access and readers (B2) | `test/review-fixes.test.mjs` B2, `test/v2-f1.test.mjs` |
| Valid | Any | Artifact of another workspace (or any workspace, for a free agent) | Agent `publish` / `restore` / `status` / `sites` | Refused or not listed: agents act only in their own workspace (B1) | `test/review-fixes.test.mjs` B1 |
| Valid main token, refused Access token | Any | — | Save settings | Saved; `Sites` names the Access token as refused (B9) | `test/review-fixes.test.mjs` B9 |

## Open acceptance debts

- **Real Cloudflare account pilot (`0.5.0`)**: owner-run live verification of `settingsCheck`, pre-filled token URL in Cloudflare dashboard, `design` artifact Direct Upload, pruned-deployment local re-upload restore, >100-deployment removal, and agent `pages` tool calls against a real Cloudflare account (all development and automated QA used `test/fake-cloudflare.mjs` with zero live Cloudflare calls).
- **Native Windows / WebView2 shell and physical phone**: scratch verification covers desktop 1440px and mobile 390px viewports in Chromium; native shell and physical-phone touch interaction remain open.
- **Chosen project name with lost creation response**: remains held at `Check result` for manual Cloudflare inspection rather than adopting by name/timestamp.

## Prior release tables (0.2.0 – 0.4.1)

Migrations `001`–`005` and the lifecycle, Access (`0.3.0`), Web Analytics (`0.4.0`) and address-change (`0.4.0`) suites (`test/service.test.mjs`, `test/connection.test.mjs`, `test/access.test.mjs`, `test/analytics.test.mjs`, `test/rename.test.mjs`, `test/migration.test.mjs`) continue to run unchanged alongside `test/v2-f1.test.mjs`.

The 0.2.0–0.4.1 record follows as it stood before 0.5.0 (owner approvals, decision tables and browser evidence); it is kept, not rewritten.

### Lifecycle decision table (0.2.0)

The owner approved the publication proposal on 2026-10-03 and independent
repository ownership in the follow-up refactor. Generic artifact menus, scoped
exports, instance activation and the owner-confirmation bridge belong to PiCode.
This repository owns the Cloudflare adapter, operations, history, migrations,
UI, build and lifecycle tests.

| Conditions | Action | Evidence |
|---|---|---|
| New/unchanged/update/rollback | Pin version and remote identity/history | `service.test.mjs` |
| Prepared concurrent action/decline/stale confirmation | Refuse or cancel without effect | `service.test.mjs`; owner-confirmation bridge tested in PiCode |
| Response lost on create/deploy/delete | Reconcile; no duplicate effect | `service.test.mjs` |
| Chosen project name + lost creation response | Hold for review; never adopt by name/time | `service.test.mjs` |
| Remote deployment remains uncertain | Hold; Check result only | `service.test.mjs` |
| Update fails | Retain prior publication | `service.test.mjs` |
| Domain/deployment snapshot changes | Re-prepare before deleting | `service.test.mjs` |
| Account/identity/preview target wrong | Refuse | `service.test.mjs` |
| Local source deleted | Keep remote history, allow removal | `service.test.mjs` |
| Disable/uninstall/local archive | No implicit remote effect | no upstream lifecycle deletion handler; real acceptance debt |
| Real Cloudflare production + preview URLs | Publish/update/restore/remove and verify | acceptance debt |


Run `npm ci && npm test` in this repository. The suite covers remote effects
with an injected transport, without Cloudflare credentials.

### Browser evidence

Before extraction, scratch browser QA used the real PiCode process/bridge and a
simulated provider: publish v1, update v2, restore v1, remove; empty, blocked,
error, progress, confirmations, 760px desktop and 362px phone, light/dark.
Screenshots were read in a subagent and settled overlay audits passed.
Desktop and phone artifact actions preserved the explicitly selected versions.
Computed JavaScript resources need runtime acceptance.

### GUI v2 browser evidence

Scratch QA on 2026-10-03 used the real PiCode host, process relay and owner
confirmation with a test-only Cloudflare adapter. Desktop configuration at
1366×768 kept fields and Save above the fold; switching to Access retained
unsaved values. Mobile 360px light/dark views covered configuration and
publication confirmations. Publish v1, update v2, restore v1 and remove passed;
progress remained visible and removed sites had no dead URL actions. Screenshot
review and settled host overlay audits passed. Remote provider calls were
simulated; this does not establish production Cloudflare acceptance.

### Open acceptance

- Real Cloudflare account: publish/update/restore/remove and verify all known URLs.
- Native Windows/WebView2 and a physical phone.
- A chosen name with lost creation response stays held; no UI release is provided
  by this version. Manual review and a recovery procedure are still needed.

Disabling, uninstalling and local artifact deletion never implicitly delete
remote resources. Backups restore local history; they do not undo remote effects.

### Restricted browser evidence (0.3.0)

On 2026-10-03, the visual agent read scratch screenshots at desktop 1366×768
and mobile 360×800 in light/dark. The real PiCode host/process/owner-confirmation
bridge used a test-only provider: Restricted v1, update v2 and restore v1 preserved
readers; changing one reader to two, danger-confirmed Public, Check access and
removal passed. Missing/rejected token, missing OTP, loading/error/blocked and
progress views were covered. Visual review PASS; card yes/yes/yes/no/yes and
the real host confirmation overlay audit was ok.

Evidence remains outside this repository in PiCode's
`.worktrees/artifact-listen-toolbar/var/screenshots/access-*.png`: representative
files are `access-restricted-confirm.png`, `access-published-v1.png`,
`access-mobile-update-retains-reader.png`, `access-mobile-restore-confirm.png`,
`access-change-readers-confirm.png`, `access-changed-readers.png`,
`access-public-danger-confirm.png`, `access-public-confirmed.png`,
`access-check-local-progress-final.png`, `access-remove-confirm.png` and
`access-removed-final.png`. Setup/error evidence includes
`access-missing-token.png`, `access-missing-otp.png`,
`access-error-desktop-final.png` and `access-mobile-optional-settings.png`.

`access-unknown-simulated.png` and final Check access placement used temporary
QA injection, removed after capture. The final product change added only
`data-align-row`/`data-align-wrap` attributes on two rows; the actual iframe
auditor's geometry supplement passed with editor heights 36/36px and wrapping
action heights 36/36/36px (`ok: true`). Screenshots:
`access-tagged-actions-mobile.png`, `access-tagged-editor-mobile.png` and
`access-tagged-editor-wide.png`. This mock/browser evidence establishes no real
Access login, edge propagation, native Windows/WebView2 or physical-phone
acceptance. Release/installation receipts are recorded separately.

### GUI v2 connection decision table

| Conditions | Action/status | Evidence |
|---|---|---|
| Account/token missing | Configure connection; check has no remote call | `test/connection.test.mjs` |
| Credentials saved, no current check | Check connection; unchecked | `test/connection.test.mjs` |
| Account project-list read succeeds | Account access verified; no write-permission claim | `test/connection.test.mjs` |
| Credentials rotated | Invalidate previous check | `test/connection.test.mjs` |
| Provider denies access or response is invalid | Sanitized error; Edit connection | `test/connection.test.mjs` |
| Instance off/process unavailable | Error and settings action; no persistent skeleton | browser QA |
| Lost remote operation response | Check result; never duplicate an effect | existing lifecycle tests |

GUI ownership and documentary adaptations: VS Code extension settings, Netlify
Drop's input-to-URL path, Cloudflare Direct Upload, Vercel per-site deployment
history, and PiCode's existing Cursor density/tokens. The owner-approved proposal
is PiCode artifact `cloudflare-pages-gui-v2-benchmar-4b209f`.

### Restricted access decision table (0.3.0)

| Conditions | Action | Evidence |
|---|---|---|
| Public / old installation / optional token missing | Keep public publishing; default existing sites Public | `test/access.test.mjs`, `test/migration.test.mjs` |
| Restricted + token/organization/OTP missing | Block before remote write; settings/check action | `test/access.test.mjs` |
| Setup read succeeds | Show login configured; never certify write permission | `test/access.test.mjs` |
| Invalid/empty/oversized email list | Refuse without mutation | `test/access.test.mjs` |
| Restricted initial publish | Atomic exact-email policy before upload; root/wildcard + returned URLs verified | `test/access.test.mjs` |
| Attached custom domain | Include in confirmation, policy and anonymous checks | `test/access.test.mjs` |
| Anonymous 200/403/404 or another login organization | Hold; never certify protection or upload | `test/access.test.mjs` |
| Other Access app/path policy overlaps | Refuse; never adopt/overwrite | `test/access.test.mjs` |
| Update / Restore | Preserve readers; refuse missing/drifted restrictions | `test/access.test.mjs` |
| Reader change / revocation fails | Keep version; revoke sessions; hold until verified | `test/access.test.mjs` |
| Restricted → Public | Danger confirmation, remove only owned app, verify old URLs, no deployment | `test/access.test.mjs` |
| Lost Access create response | Hold for manual review; no duplicate app or content upload | `test/access.test.mjs` |
| Lost reader-update response | Read desired state and revoke; never repeat uncertain policy write | `test/access.test.mjs` |
| Lost Access delete + absent/present app | Settle absence / hold, never repeat delete | `test/access.test.mjs` |
| Remove restricted site + lost Pages delete | Verify project absent before first Access cleanup | `test/access.test.mjs` |
| Pages already deleted + Access cleanup returns 403 | Hold unknown/protecting; retry only Access cleanup after authorization recovers, without repeating Pages deletion | `test/access.test.mjs` |
| Remote domains/policy change after review | Refuse mutation/upload | `test/access.test.mjs` |
| Upgrade with interrupted create/deploy | Preserve correct recovery phase and history | `test/migration.test.mjs` |
| Real Access OTP, allowlisted reader policy, session revocation, restricted→public and removal cleanup | Real pilot 2026-10-04 (owner credentials): One-time PIN enabled, restricted publish held `unknown` until edge propagation then completed with protection verified before upload, reader change updated policy and revoked sessions, public change removed the app and confirmed anonymous 200, remove cleaned the analytics/Access state (`access_app=null`); interactive OTP login confirmed end to end — owner requested the code by e-mail, signed in, and read the restricted playbook (a live internal site, kept published) | real pilot, this date; custom domains remain open | acceptance debt |

Account permissions, OTP setup, allowed and denied login, real edge propagation
and revocation still require owner-assisted Cloudflare acceptance. Automated
anonymous redirect checks do not establish that an allowed reader can log in.
No core refactor or new host permission is required for this release.

The final suite passed 48 tests; the Access 403 cleanup recovery test covers the
post-Pages-delete uncertainty boundary separately from browser geometry QA.

### Web Analytics decision table (0.4.0)

| Conditions | Action | Evidence |
|---|---|---|
| Publish with analytics (UI default) | RUM site ensured by hostname, project analytics written, tag recorded, dashboard link exposed | `test/analytics.test.mjs` |
| Update without an explicit choice | Preserve current analytics | `test/analytics.test.mjs` |
| Explicit off during publish | Clear project configuration and recorded tag | `test/analytics.test.mjs` |
| Site-only analytics toggle | Owner-confirmed, no deployment, idempotent when unchanged | `test/analytics.test.mjs` |
| Analytics configured outside the extension | Refuse; never overwrite | `test/analytics.test.mjs` |
| Lost RUM create response | Adopt by hostname; never create twice | `test/analytics.test.mjs` |
| Token lacks Account Settings | Connection reports unavailable with a sanitized message | `test/connection.test.mjs` |
| Remove site | Analytics entry deleted; lost delete holds, Check result settles by absence | `test/analytics.test.mjs` |
| Real account, disposable project (probe 2026-10-04) | Plain-host RUM create returns tag/token; PATCH stores both; beacon injected into the deployment created after enabling; `null` clears; injection is per-deployment (clearing leaves the current publication reporting until republished); `DELETE /rum/site_info/{tag}` works as `dispose` uses it | browser session probe, this date |
| Dashboard visit counts and an extension-driven real pilot | Still open | acceptance debt |

### Address change decision table (0.4.0)

| Conditions | Action | Evidence |
|---|---|---|
| Public published site, free new name | Publish current version to the new project, verify, swap records, remove old | `test/rename.test.mjs` |
| Restricted site or uncertain Access state | Refuse before any effect | `test/rename.test.mjs` |
| Name in use, invalid, or unchanged | Refuse at prepare | `test/rename.test.mjs` |
| Production version changed after review | Refuse; prepare again | `test/rename.test.mjs` |
| Lost new-project creation response | Adopt only a fresh, extension-shaped project; hold otherwise | `test/rename.test.mjs` |
| Old-project delete lost or refused | Hold; never repeat; Check result settles by absence | `test/rename.test.mjs` |
| New deployment fails | Retain the old site and record; the prepared project stays for review | `test/rename.test.mjs` |
| Real addresses, dashboards and history | Pilot 2026-10-04: change address ran on real projects (old address retired, new address live with the beacon, dashboard link resolved); long-lived dashboard history for renamed sites still unobserved | acceptance debt |

### Real pilot findings and motion rebuild (2026-10-04)

The suite passes 66 tests: the 48 from 0.3.0 unchanged, plus analytics, rename,
migration 005 and connection-capability coverage.

A real-account pilot (owner token, disposable artifact, production instance
updated from this branch) exercised publish with analytics, the dashboard link
(a live pageview load), change address and remove. It caught two defects the
mocks could not, both fixed: the deployments listing called the API with
`per_page=100`, which the real endpoint refuses with HTTP 400 (now 25), and a
rename whose new deployment was still activating failed instead of waiting in
`verifying` for tick/reconcile (regression test added). The publication motion
was rebuilt on the benchmark pattern (phase dots, determinate per-file upload
bar, sliding edge line, reduced-motion honored) after the owner rejected the
old single-block sweep; upload progress is tracked per file into the operation
row. The mobile 360px view renders the full form and card, but synthetic
input into the sandboxed iframe was not routed by the mobile shell, so mobile
interaction remains covered only by the shared desktop code path. One host-side
oddity was observed after the update (the extension artifact list briefly
returned a single page artifact while the owner route listed all 64); it did
not reproduce on retry and is recorded for the host maintainers. The pilot
site, artifact and simulator were removed; legacy sites were untouched.

### Browser evidence (0.4.0)

On 2026-10-04, scratch QA used the real PiCode host (instance `cfpages-v2`,
0.4.0 installed from the worktree package, database version 4 confirmed after
install) with the real process relay, owner-confirmation bridge and a
temporary in-memory Cloudflare simulator (persistent across process restarts;
removed with the scratch). Verified: connection check including the analytics
capability; publish with analytics on creating the RUM site and writing the
project configuration; update preserving analytics; site-only disable with the
per-deployment wording and re-enable; the View analytics dashboard link;
change address end to end (danger confirmation naming the retiring address and
deployment URLs, old project removed, new analytics adopted, history moved);
remove deleting the site and its analytics entry; removed and empty states.
Desktop light and dark passed (overlay audit ok, control heights aligned).
Two defects found and fixed in this release: the publish form did not send
the analytics choice, and the address editor's submit button stayed disabled
while typing. The mobile 360px view rendered the full form and card; mobile
interaction could not be driven because the mobile shell did not route
synthetic input into the sandboxed iframe — the page code is identical to the
verified desktop path, and physical-phone acceptance remains tracked below.
