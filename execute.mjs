// picode-tools/1 executor for Cloudflare Pages (D3, ADR-0240).
// Only the background process writes data.db (ADR-0230 item 8), so this
// one-shot executor forwards each call to the running process over loopback
// using the 0600 <dataDir>/process.json door file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";

const fail = (text) => process.stdout.write(JSON.stringify({ content: [{ type: "text", text }], isError: true }));
const AWAY = "Cloudflare Pages is not running right now. Check that the extension is enabled in Extensions, then try again.";
const WAIT_MS = 35_000;

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let req;
try {
  req = JSON.parse(raw);
} catch {
  fail("Invalid tool request JSON.");
  process.exit(0);
}

const dataDir = req?.context?.dataDir || process.env.PICODE_EXT_DATA;
if (!dataDir) {
  fail("Missing extension data directory in tool context.");
  process.exit(0);
}

let door;
try {
  door = JSON.parse(readFileSync(join(dataDir, "process.json"), "utf8"));
} catch {
  fail(AWAY);
  process.exit(0);
}

if (!Number.isInteger(door?.port) || door.port < 1 || !door?.key) {
  fail(AWAY);
  process.exit(0);
}
if (Number.isInteger(door.pid) && door.pid > 0) {
  try {
    process.kill(door.pid, 0);
  } catch (e) {
    if (e.code === "ESRCH") {
      fail(AWAY);
      process.exit(0);
    }
  }
}

const body = JSON.stringify(req);
const answer = await new Promise((resolve) => {
  const r = request(
    {
      host: "127.0.0.1",
      port: door.port,
      path: "/__tool",
      method: "POST",
      timeout: WAIT_MS,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-pages-tool-key": door.key,
      },
    },
    (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, data }));
    },
  );
  r.on("timeout", () => r.destroy(Object.assign(new Error("timeout"), { code: "TIMEOUT" })));
  r.on("error", (e) => resolve(e.code === "ECONNREFUSED" ? { away: true } : { lost: true }));
  r.end(body);
});

if (answer.away) {
  fail(AWAY);
} else if (answer.lost) {
  fail("Cloudflare Pages did not answer in time; check status before retrying so nothing is duplicated.");
} else {
  let out = null;
  try {
    out = JSON.parse(answer.data || "{}");
  } catch {
    out = null;
  }
  if (out && Array.isArray(out.content)) {
    process.stdout.write(JSON.stringify(out));
  } else {
    fail(out?.error || AWAY);
  }
}
