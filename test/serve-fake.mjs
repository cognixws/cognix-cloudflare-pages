// Test and scratch-QA entry: the extension process bound to a local fake
// Cloudflare API (test/fake-cloudflare.mjs). The URL is read here, never by
// the production entry server.mjs; Cloudflare refuses a non-loopback URL.
import { Cloudflare } from "../cloudflare.mjs";
import { startPages } from "../app.mjs";

const base = process.env.CLOUDFLARE_PAGES_FAKE_API_URL;
if (!base) throw new Error("Set CLOUDFLARE_PAGES_FAKE_API_URL to the fake Cloudflare API.");
startPages({ remote: (account, apiToken) => new Cloudflare(account, apiToken, fetch, base) });
