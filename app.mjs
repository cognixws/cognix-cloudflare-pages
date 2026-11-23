import http from "node:http";
import https from "node:https";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RemoteError } from "./cloudflare.mjs";
import { PagesService } from "./service.mjs";

// The process body. server.mjs starts it with the real Cloudflare client;
// test/serve-fake.mjs starts it with a client bound to a local fake API, so
// the production entry never reads a test URL from the environment (B5).
export function startPages({ remote }) {
const env = process.env;
const url = new URL(env.PICODE_URL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
 throw new Error("COGNIX[WS] Host API must use loopback.");
}
const token = env.PICODE_EXT_TOKEN;
const secret = env.PICODE_EXT_PROXY_SECRET;
const dataDir = env.PICODE_EXT_DATA;

// Reuse one keep-alive HTTP/HTTPS agent for the life of the process so Host API
// calls never leak ephemeral ports (extensions.md:431-466), and verify the
// daemon's local certificate authority via PICODE_CA_FILE when present.
function buildHostAgent() {
 if (url.protocol !== "https:") {
  return new http.Agent({ keepAlive: true, maxSockets: 16 });
 }
 const candidates = [
  env.PICODE_CA_FILE,
  dataDir ? join(dataDir, "..", "..", "..", "ca", "root.pem") : "",
  join(env.PICODE_DATA || join(homedir(), ".picode"), "ca", "root.pem"),
 ].filter(Boolean);
 for (const caPath of candidates) {
  try {
   const ca = readFileSync(caPath);
   return new https.Agent({ keepAlive: true, maxSockets: 16, ca });
  } catch {
   /* try next candidate */
  }
 }
 return new https.Agent({ keepAlive: true, maxSockets: 16, rejectUnauthorized: false });
}

const hostAgent = buildHostAgent();

function host(path, limit = 1 << 20, body) {
 return new Promise((resolve, reject) => {
  const target = new URL("/api/ext/v1" + path, url);
  const client = target.protocol === "https:" ? https : http;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const req = client.request(
   target,
   {
    method: payload === undefined ? "GET" : "POST",
    agent: hostAgent,
    headers: {
     "X-PiCode-Extension-Token": token,
     ...(payload !== undefined ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
    },
   },
   (res) => {
    const chunks = [];
    let bytes = 0;
    res.on("data", (b) => {
     bytes += b.length;
     if (bytes > limit) {
      res.destroy();
      reject(new RemoteError("COGNIX[WS]'s response is too large.", 409));
     } else {
      chunks.push(b);
     }
    });
    res.on("error", reject);
    res.on("end", () => {
     try {
      const r = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (res.statusCode >= 400) {
       reject(new RemoteError(typeof r.error === "string" ? r.error : "COGNIX[WS] refused the artifact request.", res.statusCode));
      } else {
       resolve(r);
      }
     } catch {
      reject(new RemoteError("COGNIX[WS] returned an unreadable response."));
     }
    });
   },
  );
  req.setTimeout(60_000, () => req.destroy(new Error("Host API timeout")));
  req.on("error", reject);
  req.end(payload);
 });
}

const db = new DatabaseSync(env.PICODE_EXT_DB);
const service = new PagesService({
 db,
 host,
 remote,
 emit: (name, data) => host("/events", 1 << 20, { name, data }),
});

const equal = (a, b) => {
 const x = Buffer.from(a || "");
 const y = Buffer.from(b || "");
 return x.length === y.length && timingSafeEqual(x, y);
};

// Private loopback door for the one-shot picode-tools/1 executor (execute.mjs).
const toolKey = randomBytes(24).toString("hex");
const doorPath = dataDir ? join(dataDir, "process.json") : "";
function writeDoorFile(listeningPort) {
 if (!doorPath) return;
 const tmp = `${doorPath}.tmp-${process.pid}`;
 writeFileSync(tmp, JSON.stringify({ port: listeningPort, key: toolKey, pid: process.pid }), { mode: 0o600 });
 renameSync(tmp, doorPath);
}
function removeDoorFile() {
 if (!doorPath) return;
 try {
  const cur = JSON.parse(readFileSync(doorPath, "utf8"));
  if (cur.pid === process.pid) unlinkSync(doorPath);
 } catch {}
}

async function readBody(req, maxBytes = 64 << 10) {
 let text = "";
 for await (const b of req) {
  text += b;
  if (text.length > maxBytes) throw new RemoteError("Request too large.", 400);
 }
 try {
  return JSON.parse(text || "{}");
 } catch {
  throw new RemoteError("Invalid request.", 400);
 }
}

const server = http.createServer(async (req, res) => {
 const send = (status, value) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
 };
 const u = new URL(req.url, "http://localhost");
 const path = u.pathname;

 // Executor loopback door (authenticated by 0600 process.json key).
 if (req.method === "POST" && path === "/__tool") {
  if (!equal(req.headers["x-pages-tool-key"], toolKey)) {
   send(403, { error: "Forbidden." });
   return;
  }
  try {
   const callReq = await readBody(req, 256 << 10);
   send(200, await service.runTool(callReq));
  } catch (e) {
   send(200, { content: [{ type: "text", text: e instanceof RemoteError ? e.message : "Tool execution failed." }], isError: true });
  }
  return;
 }

 if (!equal(req.headers["x-picode-proxy-secret"], secret)) {
  send(403, { error: "Use the COGNIX[WS] process relay." });
  return;
 }

 try {
  const body = req.method === "POST" ? await readBody(req, 32 << 10) : {};
  if (req.method === "POST" && path === "/settings/check") {
   const checked = await service.checkSettings(body);
   return send(checked.status, checked.body);
  }
  if (req.method === "POST" && path === "/connection/check") return send(200, await service.checkConnection());
  if (req.method === "POST" && path === "/access/check") return send(200, await service.checkAccessSetup());
  if (req.method === "POST" && path === "/access/verify") return send(200, await service.checkAccess(body.publicationId));
  if (req.method === "GET" && path === "/state") return send(200, await service.state());
  const reviewMatch = /^\/artifacts\/([^/]+)\/review$/.exec(path);
  if (reviewMatch && req.method === "GET") {
   const version = Number(u.searchParams.get("version") || 0);
   return send(200, await service.review(decodeURIComponent(reviewMatch[1]), version));
  }
  if (req.method === "GET" && path.startsWith("/artifacts/")) {
   return send(200, await service.source(decodeURIComponent(path.slice(11))));
  }
  if (req.method === "POST" && path === "/prepare") return send(201, await service.prepare(body));
  if (req.method === "POST" && path === "/__picode/confirm") {
   if (!equal(req.headers["x-picode-owner-confirmed"], body.revision)) {
    throw new RemoteError("Confirm this operation through COGNIX[WS].", 403);
   }
   return send(202, await service.confirm(body.operationId, body.revision));
  }
  const match = /^\/operations\/([a-zA-Z0-9-]{1,80})(?:\/(cancel|check))?$/.exec(path);
  if (match && req.method === "GET" && !match[2]) return send(200, service.operation(match[1]));
  if (match && req.method === "POST" && match[2] === "cancel") return send(200, service.cancel(match[1]));
  if (match && req.method === "POST" && match[2] === "check") return send(202, service.reconcile(match[1]));
  send(404, { error: "This action is unavailable." });
 } catch (e) {
  send(e instanceof RemoteError ? e.status : 500, { error: e instanceof RemoteError ? e.message : "The extension could not complete the request." });
 }
});

server.listen(Number(env.PICODE_EXT_PORT), "127.0.0.1", () => {
 const addr = server.address();
 if (addr && typeof addr === "object") writeDoorFile(addr.port);
 void service.recover();
 void service
  .configuration()
  .then(async (c) => {
   if (c.account && c.token) {
    await service.checkConnection().catch(() => {});
    if (c.accessToken) await service.checkAccessSetup().catch(() => {});
   }
  })
  .catch(() => {});
});
const timer = setInterval(() => void service.tick(), 3000);
function shutdown() {
 service.closing = true;
 clearInterval(timer);
 removeDoorFile();
 hostAgent.destroy();
 server.close(() => {
  try { db.close(); } catch {}
 });
}
process.on("exit", removeDoorFile);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
}
