// Shared fixtures for the v2 tests: a fake COGNIX[WS] Host API with page,
// design, document and other-workspace artifacts, and the extension's schema.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { RemoteError } from "../cloudflare.mjs";

export const ACCT_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const ACCT_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const CTX = { workspace: "ws-1", agent: "a-writer" };

export function applyMigrations(db) {
 const migDir = new URL("../migrations/", import.meta.url);
 for (const file of readdirSync(migDir).sort()) {
  if (file.endsWith(".sql")) {
   db.exec(readFileSync(new URL(file, migDir), "utf8"));
  }
 }
 return db;
}

export function makeBundle(artifactId, version, files) {
 const entries = files.map((f) => {
  const buf = Buffer.from(f.content, "utf8");
  return {
   path: f.path,
   mime: f.mime || "text/html",
   sha256: createHash("sha256").update(buf).digest("hex"),
   data: buf.toString("base64"),
  };
 });
 const digest =
  "sha256:" +
  createHash("sha256")
   .update(JSON.stringify(entries.map((e) => [e.path, e.sha256])))
   .digest("hex");
 return { artifactId, version, digest, files: entries };
}

export function createFakeHost(initial = {}) {
 const settings = {
  account_id: ACCT_A,
  api_token: "cfut_fake_valid_token",
  access_api_token: "cfat_fake_access_token",
  secretsUnreadable: false,
  ...(initial.settings || {}),
 };
 const inboxNotes = [];
 const events = [];
 const artifacts = new Map();
 const siteFetches = [];

 function putArtifact(art, bundles = {}) {
  artifacts.set(art.id, { meta: { workspaceId: "ws-1", ...art }, bundles });
 }

 putArtifact(
  {
   id: "q3-report",
   title: "Q3 Revenue Report",
   kind: "page",
   liveVersion: 2,
   versions: [
    { n: 2, kind: "page", author: "a-writer", authorName: "Writer", files: [{ path: "index.html" }] },
    { n: 1, kind: "page", author: "a-writer", authorName: "Writer", files: [{ path: "index.html" }] },
   ],
  },
  {
   1: makeBundle("q3-report", 1, [{ path: "index.html", content: "<!doctype html><h1>Q3 v1</h1>" }]),
   2: makeBundle("q3-report", 2, [{ path: "index.html", content: "<!doctype html><h1>Q3 v2</h1>" }]),
  },
 );

 putArtifact(
  {
   id: "checkout-flow",
   title: "Checkout Flow",
   kind: "design",
   liveVersion: 1,
   versions: [
    {
     n: 1,
     kind: "design",
     author: "a-designer",
     authorName: "Designer",
     files: [{ path: "index.html" }, { path: "screens/cart.html" }],
    },
   ],
  },
  {
   1: makeBundle("checkout-flow", 1, [
    { path: "index.html", content: "<!doctype html><title>Checkout Design</title>" },
    { path: "screens/cart.html", content: "<!doctype html><main>Cart screen</main>" },
   ]),
  },
 );

 putArtifact(
  {
   id: "stateful-app",
   title: "Workspace Tracker",
   kind: "page",
   liveVersion: 1,
   versions: [
    {
     n: 1,
     kind: "page",
     capabilities: ["state", "picode"],
     author: "a-builder",
     authorName: "Builder",
     files: [{ path: "index.html" }],
    },
   ],
  },
  {},
 );

 putArtifact(
  {
   id: "arch-doc",
   title: "Architecture Notes",
   kind: "document",
   liveVersion: 1,
   versions: [{ n: 1, kind: "document", files: [{ path: "README.md" }] }],
  },
  {},
 );

 putArtifact(
  {
   id: "broken-page",
   title: "Broken Landing",
   kind: "page",
   liveVersion: 1,
   versions: [{ n: 1, kind: "page", author: "a-builder", authorName: "Builder", files: [{ path: "app.js" }] }],
  },
  {},
 );

 putArtifact(
  {
   id: "key-leak-page",
   title: "Partner Demo",
   kind: "page",
   liveVersion: 1,
   versions: [{ n: 1, kind: "page", files: [{ path: "index.html" }, { path: "config.js" }] }],
  },
  {
   1: makeBundle("key-leak-page", 1, [
    { path: "index.html", content: "<!doctype html><h1>Demo</h1><script src='config.js'></script>" },
    {
     path: "config.js",
     mime: "text/javascript",
     content: 'const TOKEN = "cfut_SuperSecretValue1234567890";\nconst OPENAI = "sk-proj-9876543210abcdefghij";\n',
    },
   ]),
  },
 );

 putArtifact(
  {
   id: "private-notes",
   title: "Board Notes",
   kind: "page",
   liveVersion: 2,
   versions: [
    { n: 2, kind: "page", files: [{ path: "index.html" }] },
    { n: 1, kind: "page", files: [{ path: "index.html" }] },
   ],
  },
  {
   1: makeBundle("private-notes", 1, [{ path: "index.html", content: "<!doctype html><h1>Notes v1</h1>" }]),
   2: makeBundle("private-notes", 2, [{ path: "index.html", content: "<!doctype html><h1>Notes v2</h1>" }]),
  },
 );

 putArtifact(
  {
   id: "other-ws-page",
   title: "Other Team Pricing",
   kind: "page",
   workspaceId: "ws-2",
   liveVersion: 1,
   versions: [{ n: 1, kind: "page", files: [{ path: "index.html" }] }],
  },
  { 1: makeBundle("other-ws-page", 1, [{ path: "index.html", content: "<!doctype html><h1>Internal pricing</h1>" }]) },
 );

 async function host(path, _limit, body) {
  if (path === "/settings") {
   return {
    values: { account_id: settings.account_id },
    secrets: { api_token: settings.api_token, access_api_token: settings.access_api_token },
    secretsUnreadable: Boolean(settings.secretsUnreadable),
   };
  }
  if (path === "/events") {
   events.push(body);
   return { ok: true };
  }
  if (path === "/inbox") {
   inboxNotes.push(body);
   return { id: `inb-${inboxNotes.length}` };
  }
  if (path === "/artifacts") {
   return {
    artifacts: [...artifacts.values()].map(({ meta }) => ({
     id: meta.id,
     title: meta.title,
     kind: meta.kind,
     liveVersion: meta.liveVersion,
     workspaceId: meta.workspaceId,
    })),
   };
  }
  const siteMatch = /^\/artifacts\/([^/]+)\/versions\/(\d+)\/site$/.exec(path);
  if (siteMatch) {
   siteFetches.push(path);
   const entry = artifacts.get(decodeURIComponent(siteMatch[1]));
   const b = entry?.bundles?.[Number(siteMatch[2])];
   if (!b) throw new RemoteError("Artifact version has no index.html static entry.", 422);
   return b;
  }
  if (path.startsWith("/artifacts/")) {
   const id = decodeURIComponent(path.slice(11));
   const entry = artifacts.get(id);
   if (!entry) throw new RemoteError("Artifact not found.", 404);
   return { artifact: entry.meta, versions: entry.meta.versions };
  }
  throw new RemoteError("Unknown host route " + path, 404);
 }

 return { settings, inboxNotes, events, artifacts, putArtifact, host, siteFetches };
}

