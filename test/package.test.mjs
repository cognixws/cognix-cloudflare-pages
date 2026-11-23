import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { buildUI } from "../scripts/build-ui.mjs";

test("the installable UI matches the standalone build", async () => {
 assert.equal(await buildUI(), readFileSync(new URL("../ui/app.js", import.meta.url), "utf8"));
});

test("the package exposes the v0.5.0 COGNIX[WS] installation contract", () => {
 const m = JSON.parse(readFileSync(new URL("../picode-extension.json", import.meta.url), "utf8"));
 assert.equal(m.id, "cloudflare-pages");
 assert.equal(m.version, "0.5.0");
 assert.equal(m.apiVersion, 26);
 assert.equal(m.outsideEffects, true);
 assert.deepEqual(m.activation, { instance: true });
 assert.deepEqual(m.permissions, ["artifacts:read", "artifacts:export", "events:publish", "inbox:write"]);
 assert.equal(m.process.command, "node");
 assert.deepEqual(m.process.args, ["${extensionDir}/server.mjs"]);
 assert.equal(m.process.settingsCheck, "/settings/check");
 assert.equal(m.agent.executor.protocol, "picode-tools/1");
 assert.deepEqual(m.agent.executor.args, ["${extensionDir}/execute.mjs"]);
 assert.deepEqual(
  m.agent.capabilities[0].tools.map((t) => t.id),
  ["sites", "publish", "status", "restore"],
 );
 assert.deepEqual(m.ui.places, ["artifact", "settings", "inbox", "agent"]);
 assert.deepEqual(m.contributes.commands[0].artifactKinds, ["page", "design"]);
 for (const p of [
  "server.mjs",
  "execute.mjs",
  "scan.mjs",
  "ui/index.html",
  "ui/app.js",
  "vendor/blake3-wasm/dist/node/index.js",
  "vendor/blake3-wasm/dist/wasm/nodejs/blake3_js_bg.wasm",
  "migrations/001_publications.sql",
  "migrations/002_project_provenance.sql",
  "migrations/003_access.sql",
  "migrations/004_domains.sql",
  "migrations/005_analytics.sql",
  "migrations/006_v2_f1.sql",
  "analytics.mjs",
 ]) {
  assert.ok(existsSync(new URL("../" + p, import.meta.url)), p);
 }
});

test("B11: package-lock.json carries the manifest version", () => {
 const m = JSON.parse(readFileSync(new URL("../picode-extension.json", import.meta.url), "utf8"));
 const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
 const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
 assert.equal(lock.version, m.version);
 assert.equal(lock.packages[""].version, m.version);
 assert.equal(pkg.version, m.version);
});

test("B11: the startup failure offers Try again, which reloads the page", () => {
 const src = readFileSync(new URL("../ui/source.mjs", import.meta.url), "utf8");
 const failure = src.slice(src.lastIndexOf("})().catch("));
 assert.match(failure, /Sites could not start/);
 assert.match(failure, /<button type="button" class="primary" data-action="restart">Try again<\/button>/);
 assert.match(failure, /addEventListener\("click", \(\) => location\.reload\(\)\)/);
});
