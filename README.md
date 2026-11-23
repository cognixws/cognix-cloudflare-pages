# Cloudflare Pages for COGNIX[WS]

An independently maintained [COGNIX[WS]](https://github.com/cognixws/picode) extension (`cloudflare-pages`, `0.5.1`) that publishes standalone `page` and `design` artifacts as Cloudflare Pages sites with public or email-restricted access, cookie-free Web Analytics, version restore and agent publishing tools.

## Requirements

- COGNIX[WS] with extension `apiVersion` 26 (`artifactKinds` filter on `menus.artifact`, `places.artifact`, `process.settingsCheck`, `picode-tools/1`)
- Node.js 24 (built-in `node:sqlite`)

## Setup

1. In COGNIX[WS], open **Extensions → Install extension** and install `https://github.com/cognixws/cognix-cloudflare-pages` (no `npm install` or build runs at install time).
2. Open **Sites** (or **Extensions → Cloudflare Pages → Settings**). Choose **Create a token** to open Cloudflare's pre-filled token page with the exact dashboard permissions:
   - `Cloudflare Pages: Edit`
   - `Account Settings: Edit`
   - `Account Analytics: Read`
3. Paste your **Cloudflare account ID** and **Cloudflare API token** in Settings and save — `settingsCheck` verifies account access on save.
4. For **Only people I choose** (email-code login via Cloudflare Access), enable **One-time PIN** in [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) and save an optional **Cloudflare Access API token** (`Access: Apps and Policies Write`, `Access: Organizations, Identity Providers, and Groups Read`).

## Publishing from COGNIX[WS] (0.5.0)

- **Artifact menu (`⋯ → Publish to Cloudflare Pages…`)**: appears only on `page` and `design` artifacts (`artifactKinds: ["page", "design"]`) and opens **Sites** directly on that artifact's review card, with **← Back to artifact** one click away (`places.artifact`).
- **One confirmation**: **Publish vN** prepares the package and opens COGNIX[WS]'s immutable confirmation dialog directly — no duplicate form.
- **One primary action per site state (0.5.1)**: the review and **Manage site** take their buttons from one rule (`ui/actions.mjs`, table in [`docs/acceptance.md`](docs/acceptance.md#051-primary-action-table)). The version already live shows **Open site**, not **Publish vN**; after a restore, **Undo to vN** is the one action for the version that was replaced; a removed site offers **Publish again as a new site…**, and the confirmation says it creates a new site.
- **Short `.pages.dev` addresses**: new sites default to a clean title slug (`<slug>.pages.dev`), adding a short suffix only on collision or republication after removal.
- **Public notice & non-blocking key scan**: public reviews state that preview links stay reachable for up to 30 days and scan text files locally for common key/token prefixes (`cfk_`, `cfut_`, `cfat_`, `cfoat_`, `sk-`, `ghp_`, `github_pat_`, `AKIA`, `AIza`, PEM). Warnings highlight **Inspect artifact** while keeping **Publish vN** primary and unblocked.
- **Capability & kind refusals**: versions declaring workspace capabilities (`state`, `files`, `picode`, …) explain why static hosting cannot run them and offer **Ask \<Agent\> for a standalone version** (`places.agent`).
- **Restore with pruned-deployment fallback**: Cloudflare Pages retains up to 100 deployments / 30 days of preview links. **Restore** uses Cloudflare's `/rollback` when the deployment is still retained and automatically re-uploads the immutable local COGNIX[WS] artifact version when Cloudflare pruned it, keeping **Undo** to switch back. Removing a site with >100 deployments batch-prunes non-canonical deployments before deleting the project.
- **Account isolation & backup safety**: sites are isolated by `account_id` (`Other account` read-only state on account switch). Backing up `data.db` preserves full site history; when restored on a machine without `secrets.json`, **Sites** shows a **Reconnect Cloudflare** banner to re-enter the token.

## Agent tools (`pages` capability)

When granted the **Cloudflare Pages sites** (`pages`) tool capability at launch, agents can call:

- `sites` — compact list (up to 50) of the calling agent's workspace sites for the active account (`all`, `update`, `attention`, `private`, `removed`).
- `publish` — idempotently publish or update a standalone `page` or `design` artifact (posts a non-blocking **Updates** FYI to Inbox and returns `warnings[]` if a key pattern is spotted).
- `status` — inspect publication or operation state by `artifact` or `operation`.
- `restore` — restore an earlier published version (via `/rollback` or local artifact re-upload).

**Workspace scope**: an agent reaches only artifacts of its own workspace (a free agent, only artifacts outside any workspace), although the extension itself is on for the whole instance.

**Human-only controls**: removing a site, changing an existing site's access or readers (a new version keeps them), and changing an existing site's `.pages.dev` address always require the owner in **Sites**. A new site may start restricted. Every agent publish or restore, successful or failed, leaves an FYI in the Inbox.

## Development

```sh
npm ci
npm run build
npm test
```

Tests run offline against `test/fake-cloudflare.mjs` (a local loopback HTTP fake of Cloudflare v4 Pages, RUM and Access) with zero network access and zero real credentials. See [docs/host-api.md](docs/host-api.md) and [docs/acceptance.md](docs/acceptance.md).

Build and test from this repository. Development dependencies are locked in
`package-lock.json`; no PiCode checkout, sibling folder or private host import is
needed. The build bundles Zod (MIT) into the committed `ui/app.js`. Zod is
justified by PiCode's form validation contract. The installed process needs only
Node.js 24 and the shipped files; npm is not required on the PiCode server.

`vendor/blake3-wasm` is the minimal Node distribution of blake3-wasm 2.1.5
(MIT; LICENSE included), needed to match Wrangler's Pages asset hashes.
Verified npm tarball integrity:
`sha512-F1+K8EbfOZE49dtoPtmxUQrpXaBIl3ICvasLh+nJta0xkz+9kF/7uet9fLnwKqhDrmj6g+6K3Tw9yQPUg2ka5g==`.
Source: https://registry.npmjs.org/blake3-wasm/-/blake3-wasm-2.1.5.tgz.
No dependency installation occurs on process start.

The [decision table](docs/acceptance.md) distinguishes
simulated API/browser evidence from a real account pilot. Cloudflare currently
recommends Workers for new projects; this owner-approved implementation targets
Pages and keeps its adapter separate (re-checked for v2 as D9: Workers Static
Assets lacks external-DNS custom domains).

## Prior releases (0.2.0 – 0.4.1)

Kept as written for those releases; product names follow the time (PiCode is COGNIX[WS]'s code name). Where 0.5.0 differs, the sections above win.

### Host contract and upgrades

The extension calls only the versioned Host API and sandbox bridge documented in
[docs/host-api.md](docs/host-api.md). The ID remains `cloudflare-pages`; replacing
the package source preserves PiCode enablement, settings, secrets and the
extension database. Migrations 001–004 and the process/UI paths are unchanged; migration 005 adds Web Analytics state on top of the custom-domains schema.
A PiCode release supporting ADR-0249 is required before installation.

### GUI v2

The connection notice distinguishes missing settings, unchecked settings,
verified account access and rejected credentials. The check is a GET to the
account's Pages project list and creates no remote resources. Its result is kept
in process memory and invalidated when credentials change or the process
restarts. Tokens and their fingerprints never reach the page.

Each site shows its last confirmed version and access, URL, update choice and
history. Restore reviews a successful production deployment. Remove
site lives under Site settings and reviews the entire dedicated project. An
uncertain result offers Check result before another operation. A blocked or
failed load ends the loading skeleton. Save settings is performed by PiCode's
generic configuration page; it does not claim a successful connection.

### Public and Restricted access (0.3.0)

Choose **Public** or **Restricted by email** in the publication form. Existing
sites default to Public. For Restricted, enter 1–50 exact email addresses; readers
sign in with an email code. **Site settings → Change access** changes readers or
makes a site public without deploying another artifact version. Update and Restore
preserve the current access settings. Making a restricted site Public requires a
danger confirmation covering previous deployment URLs. Changing readers revokes
existing sessions, so allowed readers sign in again.

To configure Restricted:

1. Set up a [Cloudflare Zero Trust organization](https://one.dash.cloudflare.com/)
   and enable **One-time PIN** in its login methods.
2. Create a separate account-scoped token with **Access: Apps and Policies Write**
   and **Access: Organizations, Identity Providers, and Groups Read**.
3. Save it in PiCode's **Cloudflare Access API token (optional)** secret setting.
   Keep the existing Pages token. Choose Restricted and **Check restricted access**.
   This check verifies organization/login reads, not write permission.

The extension protects the production root, wildcard preview/alias hostnames and
all custom domains reported by Pages, before uploading. It refuses overlapping
Access apps, policy drift and unverified protection. Propagation may leave an
operation at **Check result**; no new content is sent until protection is verified.
A lost Access creation response or uncertain delete can require manual review;
never delete protection on a surviving site to clear a held operation.

**Check access** verifies current policy and anonymous redirects, including known
previous URLs. The card shows the last check time. These are explicit checks;
external changes in Cloudflare are not monitored continuously. Content previously
published publicly may already have been copied. See the
[security decision](docs/decisions/001-restricted-publications.md) and
[acceptance table](docs/acceptance.md) for recovery and remaining real-account QA.

### Web Analytics and address changes (0.4.0)

Publications enable Web Analytics by default; the publish form and Site settings
control it per site. Enabling adopts or creates the analytics site by hostname,
writes the project's analytics configuration and records the analytics tag, so
Cloudflare injects its privacy-first beacon from the next publication; the
current publication counts after it is published again. A site with analytics
shows **View analytics**, which opens the project's page in the Cloudflare
dashboard. A configuration written outside this extension is reported, never
overwritten. Removing a site also removes its analytics entry; a lost delete
holds with Check result and settles by absence.

**Change address** publishes the current version to a new dedicated project,
verifies it, then removes the old project: the old `pages.dev` address and its
deployment URLs stop working and version history moves to the new address.
Restricted sites cannot change address; remove and publish again instead. An
uncertain old-project delete is never repeated — Check result settles it once
the old project is gone, and removals done elsewhere in Cloudflare are detected,
not duplicated.

### Overview (0.2.0)

An independently maintained [PiCode](https://github.com/cognixws/picode) extension
for static artifact versions. Requires PiCode
with ADR-0249 and Node.js 24 (built-in SQLite). In PiCode, open **Extensions → Install extension**, paste
`https://github.com/cognixws/cognix-cloudflare-pages`, review and install; no npm install or build runs during installation. Open Configuration, enter account ID and an API token with Cloudflare Pages Edit
and — for Web Analytics — Account Settings Read and Write, and save. Open Publications and choose Check connection. The read-only account
check verifies project-list access, not write permission. Then open an artifact's
Actions → Publish to Cloudflare Pages; its exact version is selected. A custom
project name is optional under Advanced options.

The owner chooses a version and optionally a project name. Every artifact gets
one dedicated Direct Upload project. The extension never attaches an existing
project. Updates preserve its URL; successful production versions can be
restored. Remove reviews domains and deployment URLs before deleting the whole
project. Artifacts, disable/uninstall and backups do not implicitly delete sites.

Secrets stay in PiCode's encrypted settings; the sandboxed page has no token
or network. The process sends Cloudflare requests, owns its SQLite history and
reconciles uncertain operations after restart. Check result does not duplicate
an uncertain deployment/delete. A chosen project name stays held for manual
Cloudflare review if its creation response is lost; only generated names can
be reconciled without a persisted remote identity. Prepared operations can be
cancelled.

Only independent HTML pages are supported initially. Declared PiCode
capabilities require a separately published independent version. The portable
package includes assets, public local libraries, an offline bridge shim and
restrictive headers. Computed resource references need browser acceptance.

## License

Apache-2.0, matching the other CognixWS PiCode extensions. Third-party MIT notices
are retained under `vendor/`.

## Icon attribution

`ui/cloudflare.png` is Cloudflare’s official application icon, downloaded from
https://dash.cloudflare.com/apple-touch-icon-152x152.png. The Cloudflare name
and logo belong to Cloudflare; the extension is independently maintained.
