# Publication decision table and acceptance

This document tracks automated fake-provider / scratch-browser verification versus real-account and native-device acceptance debts across releases.

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

## Open acceptance debts

- **Real Cloudflare account pilot (`0.5.0`)**: owner-run live verification of `settingsCheck`, pre-filled token URL in Cloudflare dashboard, `design` artifact Direct Upload, pruned-deployment local re-upload restore, >100-deployment removal, and agent `pages` tool calls against a real Cloudflare account (all development and automated QA used `test/fake-cloudflare.mjs` with zero live Cloudflare calls).
- **Native Windows / WebView2 shell and physical phone**: scratch verification covers desktop 1440px and mobile 390px viewports in Chromium; native shell and physical-phone touch interaction remain open.
- **Chosen project name with lost creation response**: remains held at `Check result` for manual Cloudflare inspection rather than adopting by name/timestamp.

## Prior release tables (0.2.0 – 0.4.1)

Migrations `001`–`005` and the lifecycle, Access (`0.3.0`), Web Analytics (`0.4.0`) and address-change (`0.4.0`) suites (`test/service.test.mjs`, `test/connection.test.mjs`, `test/access.test.mjs`, `test/analytics.test.mjs`, `test/rename.test.mjs`, `test/migration.test.mjs`) continue to run unchanged alongside `test/v2-f1.test.mjs`.
