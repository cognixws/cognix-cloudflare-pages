import { Cloudflare } from "./cloudflare.mjs";
import { startPages } from "./app.mjs";

startPages({ remote: (account, apiToken) => new Cloudflare(account, apiToken) });
