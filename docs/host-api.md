# COGNIX[WS] host contract (0.5.0)

Requires COGNIX[WS] extension `apiVersion` 26 (`cloudflare-pages`, instance-activated, `outsideEffects: true`).

## Process & Host API

The background process (`server.mjs`) uses `PICODE_URL`, `PICODE_EXT_TOKEN`, `PICODE_EXT_PORT`, `PICODE_EXT_PROXY_SECRET`, `PICODE_EXT_DB`, `PICODE_EXT_DATA` and `PICODE_CA_FILE`, reusing a single keep-alive `http.Agent` / `https.Agent` for the life of the process.

| Host API route (`/api/ext/v1`) | Permission | Use |
|---|---|---|
| `GET /settings` | (process) | Encrypted account ID and API tokens |
| `GET /artifacts` | `artifacts:read` | Workspace `page` and `design` metadata |
| `GET /artifacts/{id}` | `artifacts:read` | Artifact metadata, version authors and declared capabilities |
| `GET /artifacts/{id}/versions/{n}/site` | `artifacts:export` | Portable static bundle (`index.html`, assets, `_headers`, offline shim) |
| `POST /events` | `events:publish` | Push progress & completion invalidations to `Sites` |
| `POST /inbox` | `inbox:write` | Non-blocking **Updates** FYI when an agent publishes or restores |

`process.settingsCheck` points to `POST /settings/check`, validating the 32-hex `account_id`, Cloudflare Pages project-list access (`api_token`) and optional Zero Trust Access setup (`access_api_token`) when saving settings.

## Agent executor (`picode-tools/1`)

`execute.mjs` implements `picode-tools/1` for capability `pages` (`sites`, `publish`, `status`, `restore`). Because only `server.mjs` writes `data.db` (ADR-0230 single-writer SQLite rule), `server.mjs` writes `<PICODE_EXT_DATA>/process.json` (`0600`) with its loopback port and random per-boot key, and `execute.mjs` forwards tool invocations to `POST /__tool`.

## Sandboxed UI doors

`ui/index.html` runs sandboxed with zero direct network access and calls `picode.use` for:
- `process` (`/state`, `/artifacts/:id/review`, `/prepare`, `/operations/:id`, `/connection/check`, `/access/check`, `/access/verify`)
- `confirm` (`confirm.operation(id)` — immutable `X-PiCode-Owner-Confirmed` verification)
- `events` (live progress updates)
- `context` (`{ artifactId, version }` from `menus.artifact` filtered by `artifactKinds: ["page", "design"]`)
- `places` (`artifact`, `settings`, `inbox`, `agent`)
- `links` (`open`, `copy`)

## Prior releases: contract as of 0.4.1

Kept as written for 0.2–0.4 (confirmation, analytics, address change and restricted-access doors still apply unchanged in 0.5.0; only the manifest API version moved to 26).

Requires PiCode's ADR-0249 generic artifact extension doors. The manifest keeps
API version 2 and ID `cloudflare-pages`. The package is instance-activated.

The process uses `PICODE_URL`, `PICODE_EXT_TOKEN`, `PICODE_EXT_PORT`,
`PICODE_EXT_PROXY_SECRET` and `PICODE_EXT_DB` supplied by the host. The Host API
is loopback-only at `/api/ext/v1`, authenticated with
`X-PiCode-Extension-Token`. Its documented doors are:

| Route | Use |
|---|---|
| GET /settings | Encrypted account/token settings, process only |
| GET /artifacts | Scoped metadata (`artifacts:read`) |
| GET /artifacts/{id} | Metadata and versions (`artifacts:read`) |
| GET /artifacts/{id}/versions/{n}/site | Static package (`artifacts:export`) |
| POST /events | Own progress invalidation (`events:publish`) |

The site JSON contains `artifactId`, `version`, `digest` and `files`; each file
has `path`, `mime`, `sha256` and base64 `data`. The process receives packages
directly rather than through the page relay. Instance-off denies artifact access.

The sandbox page uses `picode.use` for `process`, `confirm`, `events`, `context`
and `links`. Artifact context includes a host-validated `artifactId` and integer
`version`. Events invalidate persisted state without page polling.

The page prepares an operation through the process relay, then calls
`confirm.operation(id)`. PiCode reads `/operations/{id}` and draws its own
confirmation. Only the host owner endpoint adds `X-PiCode-Owner-Confirmed` to
`/__picode/confirm`. The process checks that header against the immutable
revision and revalidates remote state before an effect. Ordinary page requests
cannot supply this header.

Extension processes are trusted local programs, not sandboxed processes. The
page never receives credentials, artifact packages or direct network access.

GUI v2 uses the existing relay for POST `/connection/check` and GET `/state`.
The latter includes connection status and sanitized check messages only. The
process obtains credentials through the Host API, checks the account project
list with a GET, and keeps a private credential fingerprint in memory. A check
never creates a project or proves write permission. Original artifact/version
context continues through the existing host context; no protocol door is added.

Web Analytics and address changes use only the same process/confirmation doors.
`/prepare` accepts `analytics:boolean` on publish, action `analytics` with
`{publicationId,analytics:boolean}` and action `rename` with
`{publicationId,projectName}`. `/state` exposes a per-publication `analytics`
object with the dashboard URL and the connection check reports the analytics
capability; no new protocol door is added.

Restricted access uses only the same process/confirmation doors. POST
`/access/check` is a read-only organization/OTP/app-list check; POST
`/access/verify` with `publicationId` checks policy and anonymous site redirects.
`/prepare` accepts optional `{mode:"public"|"restricted", emails:[...]}` as `access`
for Publish, and action `access` with `publicationId` for a site-only access change.
Restore and removal cannot override access settings. The immutable owner-reviewed
revision includes desired access, domains and the current Access policy snapshot.
`/state` exposes mode, readers, verified time and sanitized setup status; tokens,
private credential fingerprints and Access resource IDs stay in the process.
