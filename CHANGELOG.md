# Changelog

## 0.5.0

- **Focused artifact review (D1c & D2)**: `⋯ → Publish to Cloudflare Pages…` appears only on `page` and `design` artifacts (`apiVersion: 26` `artifactKinds`), opens **Sites** directly on the artifact's review with one-click **← Back to artifact** (`places.artifact`), and opens COGNIX[WS]'s confirmation dialog directly on **Publish vN**.
- **Agent publishing tools (D3)**: add `picode-tools/1` capability `pages` (`sites`, `publish`, `status`, `restore`) with bounded output and non-blocking **Updates** FYI notes in Inbox; keep site removal, restricted-to-public changes and address renames owner-only.
- **Short `.pages.dev` slugs (D7)**: generate readable title slugs for new sites with automatic short suffixes on collision.
- **Guided token setup & Reconnect (D8 & D13)**: add pre-filled Cloudflare API token link with exact dashboard permission labels, verify credentials on save (`process.settingsCheck`), show **Reconnect** on 401/403 or after `data.db` backup restore, and isolate rows across Cloudflare `account_id` switches.
- **Restore fallback & >100 deploy cleanup (D10)**: fall back to re-uploading the immutable local COGNIX[WS] artifact version when Cloudflare pruned an older deployment, keep one-click **Undo** after Restore, and batch-prune non-canonical deployments before deleting projects with >100 deployments.
- **Public notice, non-blocking key scan & clear refusals (D11 & D12)**: support `design` artifacts alongside `page`, warn without blocking when text files match common key prefixes (`warnings[]` on agent `publish`), and guide standalone versions via `places.agent` when a version declares workspace capabilities.

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
