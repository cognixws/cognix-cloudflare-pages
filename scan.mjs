// Non-blocking pre-publish secret pattern scanner (D11), pre-filled token
// template URL builder (D8), and short title-slug generator (D7).

const TEXT_EXTENSIONS = new Set([
  ".html", ".htm", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".json", ".css", ".svg", ".txt", ".md", ".xml", ".yml", ".yaml",
  ".toml", ".ini", ".cfg", ".conf", ".env", ".csv", ".map",
]);

const SECRET_RULES = [
  {
    re: /\b(cfk_|cfut_|cfat_|cfoat_)[A-Za-z0-9_-]{8,}/,
    label: "Cloudflare token prefix",
    prefix: (m) => m[1] + "…",
  },
  {
    re: /\b(sk-(?:proj-|ant-)?)[A-Za-z0-9_-]{12,}/,
    label: "API key prefix",
    prefix: (m) => m[1] + "…",
  },
  {
    re: /\b(github_pat_|gh[pousr]_)[A-Za-z0-9_]{16,}/,
    label: "GitHub token prefix",
    prefix: (m) => m[1] + "…",
  },
  {
    re: /\b(AKIA)[0-9A-Z]{12,}/,
    label: "AWS access key prefix",
    prefix: (m) => m[1] + "…",
  },
  {
    re: /\b(AIza)[0-9A-Za-z_-]{30,}/,
    label: "Google API key prefix",
    prefix: (m) => m[1] + "…",
  },
  {
    re: /\b(xox[abprs]-|glpat-|hf_|npm_|[sr]k_live_)[A-Za-z0-9_-]{10,}/,
    label: "Service token prefix",
    prefix: (m) => m[1] + "…",
  },
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    label: "Private key block",
    prefix: () => "-----BEGIN … PRIVATE KEY-----",
  },
];

function isScannableFile(file) {
  const p = String(file?.path || "");
  if (!p || p === "_headers" || p.startsWith("_picode/") || p.startsWith("__picode/")) return false;
  const mime = String(file?.mime || "").toLowerCase();
  if (mime.startsWith("text/") || mime.includes("javascript") || mime.includes("json") || mime.includes("xml") || mime.includes("svg")) {
    return true;
  }
  const dot = p.lastIndexOf(".");
  if (dot >= 0 && TEXT_EXTENSIONS.has(p.slice(dot).toLowerCase())) return true;
  return p === ".env" || p.endsWith("/.env");
}

// scanBundleForSecrets inspects text assets in a SiteBundle and returns up to
// maxFindings masked location/prefix hints. Never returns secret material and
// never blocks publication (D11).
export function scanBundleForSecrets(bundle, maxFindings = 5) {
  const warnings = [];
  const files = Array.isArray(bundle?.files) ? bundle.files : [];
  for (const file of files) {
    if (warnings.length >= maxFindings) break;
    if (!isScannableFile(file) || !file?.data) continue;
    let buf;
    try {
      buf = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), "base64");
    } catch {
      continue;
    }
    if (buf.length > 2 * 1024 * 1024 || buf.includes(0)) continue;
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length && warnings.length < maxFindings; i++) {
      const line = lines[i];
      if (!line || line.length > 16384) continue;
      for (const rule of SECRET_RULES) {
        const m = rule.re.exec(line);
        if (m) {
          const prefix = rule.prefix(m);
          warnings.push({
            file: file.path,
            line: i + 1,
            label: rule.label,
            prefix,
            message: `Possible key format in ${file.path}:${i + 1} (${rule.label} ${prefix})`,
          });
          break;
        }
      }
    }
  }
  return warnings;
}

// Pre-filled Cloudflare API token creation link (D8). Uses the account-owned
// token URL when a 32-hex account ID is configured (which validates canonical
// permission group keys), and the user profile API tokens URL otherwise.
export const DASHBOARD_PERMISSION_LABELS = [
  "Cloudflare Pages: Edit",
  "Account Settings: Edit",
  "Account Analytics: Read",
];

export function tokenTemplateURL(accountId = "") {
  const keys = JSON.stringify([
    { key: "page", type: "edit" },
    { key: "account_settings", type: "edit" },
    { key: "account_analytics", type: "read" },
  ]);
  const name = "COGNIX[WS] Cloudflare Pages";
  const clean = String(accountId || "").trim();
  if (/^[a-fA-F0-9]{32}$/.test(clean)) {
    const params = new URLSearchParams({
      to: `/${clean}/api-tokens`,
      permissionGroupKeys: keys,
      name,
    });
    return `https://dash.cloudflare.com/?${params.toString()}`;
  }
  const params = new URLSearchParams({
    permissionGroupKeys: keys,
    name,
  });
  return `https://dash.cloudflare.com/profile/api-tokens?${params.toString()}`;
}

export function maskAccountId(accountId = "") {
  const clean = String(accountId || "").trim();
  if (clean.length <= 10) return clean;
  return `${clean.slice(0, 6)}…${clean.slice(-4)}`;
}

// Short title-slug project names for new sites (D7). Keeps lowercase ASCII
// letters, digits and single hyphens, between 3 and 40 characters.
export function shortSlug(title = "", fallbackSuffix = "site") {
  let base = String(title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  if (base.length < 3) {
    const tail = String(fallbackSuffix || "site").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6) || "site";
    base = (base ? `${base}-${tail}` : `site-${tail}`).slice(0, 40);
  }
  return base;
}
