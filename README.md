# Cloudflare Pages for COGNIX[WS]

An independently maintained [COGNIX[WS]](https://github.com/cognixws/picode) extension (`cloudflare-pages`, `0.5.0`) that publishes standalone `page` and `design` artifacts as Cloudflare Pages sites with public or email-restricted access, cookie-free Web Analytics, version restore and agent publishing tools.

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
- **Short `.pages.dev` addresses**: new sites default to a clean title slug (`<slug>.pages.dev`), adding a short suffix only on collision or republication after removal.
- **Public notice & non-blocking key scan**: public reviews state that preview links stay reachable for up to 30 days and scan text files locally for common key/token prefixes (`cfk_`, `cfut_`, `cfat_`, `cfoat_`, `sk-`, `ghp_`, `github_pat_`, `AKIA`, `AIza`, PEM). Warnings highlight **Inspect artifact** while keeping **Publish vN** primary and unblocked.
- **Capability & kind refusals**: versions declaring workspace capabilities (`state`, `files`, `picode`, …) explain why static hosting cannot run them and offer **Ask \<Agent\> for a standalone version** (`places.agent`).
- **Restore with pruned-deployment fallback**: Cloudflare Pages retains up to 100 deployments / 30 days of preview links. **Restore** uses Cloudflare's `/rollback` when the deployment is still retained and automatically re-uploads the immutable local COGNIX[WS] artifact version when Cloudflare pruned it, keeping **Undo** to switch back. Removing a site with >100 deployments batch-prunes non-canonical deployments before deleting the project.
- **Account isolation & backup safety**: sites are isolated by `account_id` (`Other account` read-only state on account switch). Backing up `data.db` preserves full site history; when restored on a machine without `secrets.json`, **Sites** shows a **Reconnect Cloudflare** banner to re-enter the token.

## Agent tools (`pages` capability)

When granted the **Cloudflare Pages sites** (`pages`) tool capability at launch, agents can call:

- `sites` — compact list (up to 50) for the active account (`all`, `update`, `attention`, `private`, `removed`).
- `publish` — idempotently publish or update a standalone `page` or `design` artifact (posts a non-blocking **Updates** FYI to Inbox and returns `warnings[]` if a key pattern is spotted).
- `status` — inspect publication or operation state by `artifact` or `operation`.
- `restore` — restore an earlier published version (via `/rollback` or local artifact re-upload).

**Human-only controls**: removing a site, making an existing restricted site public, and changing an existing site's `.pages.dev` address always require the owner in **Sites**.

## Development

```sh
npm ci
npm run build
npm test
```

Tests run offline against `test/fake-cloudflare.mjs` (a local loopback HTTP fake of Cloudflare v4 Pages, RUM and Access) with zero network access and zero real credentials. See [docs/host-api.md](docs/host-api.md) and [docs/acceptance.md](docs/acceptance.md).

## License & Icon attribution

Apache-2.0 (`vendor/blake3-wasm` 2.1.5 is MIT; license retained). `ui/cloudflare.png` belongs to Cloudflare, Inc.; this extension is independently maintained.
