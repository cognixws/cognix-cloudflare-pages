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
