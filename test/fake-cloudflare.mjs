// Local HTTP fake of the Cloudflare v4 Pages, RUM and Access APIs for unit
// tests and scratch-instance QA. Binds to 127.0.0.1 only; makes zero outbound
// network requests.
import http from "node:http";

export async function startFakeCloudflare(options = {}) {
  const state = {
    validTokens: new Set(options.tokens || ["cfut_fake_valid_token", "cfut_fake_account_b"]),
    accessTokens: new Set(options.accessTokens || ["cfat_fake_access_token", "cfut_fake_valid_token"]),
    expiredTokens: new Set(),
    denyRum: false,
    uploadDelayMs: 0,
    failDeployStatus: 0,
    authDomain: options.authDomain || "cognix-test.cloudflareaccess.com",
    otpEnabled: options.otpEnabled !== false,
    accounts: new Map(), // accountId -> { projects: Map, rumSites: Map, accessApps: Map }
    assets: new Map(), // hash -> { value, metadata }
    requests: [],
  };

  function acct(id) {
    if (!state.accounts.has(id)) {
      state.accounts.set(id, {
        projects: new Map(),
        rumSites: new Map(),
        accessApps: new Map(),
        seq: 0,
      });
    }
    return state.accounts.get(id);
  }

  function send(res, status, payload) {
    const raw = JSON.stringify(payload);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw) });
    res.end(raw);
  }

  function ok(res, result, extra = {}) {
    send(res, 200, { success: true, errors: [], messages: [], result, ...extra });
  }

  function err(res, status, message = "Forbidden") {
    send(res, status, { success: false, errors: [{ code: status, message }], result: null });
  }

  function bearer(req) {
    const h = String(req.headers.authorization || "");
    return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  }

  async function readRaw(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks);
  }

  async function readJSON(req) {
    const buf = await readRaw(req);
    if (!buf.length) return {};
    return JSON.parse(buf.toString("utf8"));
  }

  // Parse multipart FormData sent by Cloudflare.deploy / createDeployment.
  function parseMultipart(buf, contentType) {
    const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || "");
    if (!m) return {};
    const boundary = "--" + (m[1] || m[2]);
    const text = buf.toString("latin1");
    const parts = text.split(boundary).slice(1, -1);
    const fields = {};
    for (const part of parts) {
      const idx = part.indexOf("\r\n\r\n");
      if (idx < 0) continue;
      const head = part.slice(0, idx);
      const body = Buffer.from(part.slice(idx + 4, part.endsWith("\r\n") ? part.length - 2 : part.length), "latin1").toString("utf8");
      const nameMatch = /name="([^"]+)"/.exec(head);
      if (nameMatch) fields[nameMatch[1]] = body;
    }
    return fields;
  }

  function hostCoveredByAccess(hostname) {
    const h = hostname.toLowerCase();
    for (const a of state.accounts.values()) {
      for (const app of a.accessApps.values()) {
        const dests = (app.destinations || []).map((d) => String(d.uri || "").toLowerCase());
        if (app.domain) dests.push(String(app.domain).toLowerCase());
        for (const pat of dests) {
          if (pat === h) return true;
          if (pat.startsWith("*.")) {
            const root = pat.slice(2);
            if (h === root || h.endsWith("." + root)) return true;
          }
        }
      }
    }
    return false;
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const method = req.method || "GET";
    state.requests.push({ method, path: u.pathname, query: u.search });

    try {
      // Control endpoints for tests & scratch QA.
      if (u.pathname === "/__fake/state" && method === "GET") {
        const summary = {};
        for (const [aid, a] of state.accounts) {
          summary[aid] = {
            projects: [...a.projects.values()],
            rumSites: [...a.rumSites.values()],
            accessApps: [...a.accessApps.values()],
          };
        }
        return send(res, 200, { accounts: summary, requests: state.requests.length });
      }
      if (u.pathname === "/__fake/control" && method === "POST") {
        const body = await readJSON(req);
        if (body.expireToken) state.expiredTokens.add(body.expireToken);
        if (body.restoreToken) {
          state.expiredTokens.delete(body.restoreToken);
          state.validTokens.add(body.restoreToken);
        }
        if (body.addToken) state.validTokens.add(body.addToken);
        if (body.addAccessToken) state.accessTokens.add(body.addAccessToken);
        if (typeof body.denyRum === "boolean") state.denyRum = body.denyRum;
        if (typeof body.uploadDelayMs === "number") state.uploadDelayMs = body.uploadDelayMs;
        if (typeof body.failDeployStatus === "number") state.failDeployStatus = body.failDeployStatus;
        if (body.pruneDeployment) {
          const { accountId, project, deploymentId } = body.pruneDeployment;
          const p = acct(accountId).projects.get(project);
          if (p) p.deployments = p.deployments.filter((d) => d.id !== deploymentId);
        }
        return send(res, 200, { ok: true });
      }

      // Edge probe endpoint used by PublicationAccess anonymous/public checks.
      if (u.pathname.startsWith("/__edge/")) {
        const hostname = decodeURIComponent(u.pathname.slice(8).replace(/\/+$/, ""));
        if (hostCoveredByAccess(hostname)) {
          res.writeHead(302, { Location: `https://${state.authDomain}/cdn-cgi/access/login/site` });
          return res.end();
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end("<!doctype html><title>Live</title>");
      }

      const token = bearer(req);

      // Upload JWT asset endpoints.
      if (u.pathname.startsWith("/client/v4/pages/assets/")) {
        if (!token.startsWith("jwt_")) return err(res, 401, "Invalid upload JWT");
        if (state.uploadDelayMs > 0) await new Promise((r) => setTimeout(r, state.uploadDelayMs));
        if (u.pathname.endsWith("/check-missing") && method === "POST") {
          const body = await readJSON(req);
          const missing = (body.hashes || []).filter((h) => !state.assets.has(h));
          return ok(res, missing);
        }
        if (u.pathname.endsWith("/upload") && method === "POST") {
          const items = await readJSON(req);
          for (const item of items || []) {
            state.assets.set(item.key, { value: item.value, metadata: item.metadata });
          }
          return ok(res, {});
        }
        if (u.pathname.endsWith("/upsert-hashes") && method === "POST") {
          return ok(res, {});
        }
      }

      // Standard API token verification.
      if (!token || state.expiredTokens.has(token)) {
        return err(res, 401, "Invalid API Token");
      }

      // Access endpoints.
      const accessMatch = /^\/client\/v4\/accounts\/([a-fA-F0-9]{32})\/access\/(.+)$/.exec(u.pathname);
      if (accessMatch) {
        if (!state.accessTokens.has(token)) return err(res, 403, "Access token denied");
        const [, accountId, rest] = accessMatch;
        const a = acct(accountId);
        if (rest === "organizations" && method === "GET") {
          return ok(res, state.authDomain ? { auth_domain: state.authDomain } : {});
        }
        if (rest === "identity_providers" && method === "GET") {
          return ok(res, state.otpEnabled ? [{ id: "otp-1", type: "onetimepin" }] : []);
        }
        if (rest === "apps" && method === "GET") {
          return ok(res, [...a.accessApps.values()]);
        }
        if (rest === "apps" && method === "POST") {
          const body = await readJSON(req);
          const id = "app-" + (++a.seq);
          const policies = (body.policies || []).map((p, idx) => ({ ...p, id: `pol-${id}-${idx}` }));
          const app = { ...body, id, policies };
          a.accessApps.set(id, app);
          return ok(res, app);
        }
        const appMatch = /^apps\/([^/]+)(?:\/(.+))?$/.exec(rest);
        if (appMatch) {
          const [, appId, sub] = appMatch;
          const app = a.accessApps.get(appId);
          if (!app) return err(res, 404, "App not found");
          if (!sub && method === "GET") return ok(res, app);
          if (!sub && method === "PUT") {
            const body = await readJSON(req);
            Object.assign(app, body, { id: app.id, policies: app.policies });
            return ok(res, app);
          }
          if (!sub && method === "DELETE") {
            a.accessApps.delete(appId);
            return ok(res, { id: appId });
          }
          if (sub === "policies" && method === "GET") return ok(res, app.policies || []);
          if (sub?.startsWith("policies/") && method === "PUT") {
            const polId = sub.slice(9);
            const body = await readJSON(req);
            const updated = { ...body, id: polId };
            app.policies = [updated];
            return ok(res, updated);
          }
          if (sub === "revoke_tokens" && method === "POST") return ok(res, {});
        }
        return err(res, 404, "Unknown Access endpoint");
      }

      if (!state.validTokens.has(token)) {
        return err(res, 403, "Token lacks permission");
      }

      // RUM Web Analytics endpoints.
      const rumMatch = /^\/client\/v4\/accounts\/([a-fA-F0-9]{32})\/rum\/site_info(?:\/(.+))?$/.exec(u.pathname);
      if (rumMatch) {
        if (state.denyRum) return err(res, 403, "Missing Account Settings: Edit");
        const [, accountId, sub] = rumMatch;
        const a = acct(accountId);
        if (sub === "list" && method === "GET") return ok(res, [...a.rumSites.values()]);
        if (!sub && method === "POST") {
          const body = await readJSON(req);
          const n = ++a.seq;
          const site = { site_tag: `rum_tag_${n}`, site_token: `rum_tok_${n}`, host: body.host };
          a.rumSites.set(site.site_tag, site);
          return ok(res, site);
        }
        if (sub && method === "DELETE") {
          const tag = decodeURIComponent(sub);
          if (!a.rumSites.has(tag)) return err(res, 404, "RUM site not found");
          a.rumSites.delete(tag);
          return ok(res, { site_tag: tag });
        }
      }

      // Pages projects endpoints.
      const pagesMatch = /^\/client\/v4\/accounts\/([a-fA-F0-9]{32})\/pages\/projects(?:\/([^/]+)(?:\/(.+))?)?$/.exec(u.pathname);
      if (pagesMatch) {
        const [, accountId, rawProject, sub] = pagesMatch;
        const a = acct(accountId);
        if (!rawProject && method === "GET") {
          return ok(res, [...a.projects.values()].map(projectView));
        }
        if (!rawProject && method === "POST") {
          const body = await readJSON(req);
          if (a.projects.has(body.name)) return err(res, 409, "Project already exists");
          const p = {
            id: `proj_${++a.seq}`,
            name: body.name,
            subdomain: `${body.name}.pages.dev`,
            production_branch: body.production_branch || "main",
            created_on: new Date().toISOString(),
            domains: [`${body.name}.pages.dev`],
            build_config: {},
            deployments: [],
            canonical_id: null,
          };
          a.projects.set(p.name, p);
          return ok(res, projectView(p));
        }
        const projectName = decodeURIComponent(rawProject);
        const p = a.projects.get(projectName);
        if (!p) return err(res, 404, "Project not found");

        if (!sub && method === "GET") return ok(res, projectView(p));
        if (!sub && method === "PATCH") {
          const body = await readJSON(req);
          if (body.build_config) p.build_config = { ...p.build_config, ...body.build_config };
          return ok(res, projectView(p));
        }
        if (!sub && method === "DELETE") {
          // Real Cloudflare Pages refuses deleting a project with >100 deployments (D10).
          if (p.deployments.length > 100) {
            return err(res, 400, "Project has too many deployments to delete; delete deployments first");
          }
          a.projects.delete(projectName);
          return ok(res, null);
        }
        if (sub === "upload-token" && method === "GET") {
          return ok(res, { jwt: `jwt_${accountId}_${projectName}` });
        }
        if (sub === "deployments" && method === "GET") {
          const page = Math.max(1, Number(u.searchParams.get("page") || 1));
          const perPage = Math.max(1, Number(u.searchParams.get("per_page") || 25));
          const list = p.deployments.slice((page - 1) * perPage, page * perPage);
          return ok(res, list, {
            result_info: { page, per_page: perPage, total_count: p.deployments.length, total_pages: Math.max(1, Math.ceil(p.deployments.length / perPage)) },
          });
        }
        if (sub === "deployments" && method === "POST") {
          if (state.failDeployStatus > 0) return err(res, state.failDeployStatus, "Simulated deploy failure");
          const rawBuf = await readRaw(req);
          const fields = parseMultipart(rawBuf, req.headers["content-type"]);
          const id = `dep_${++a.seq}`;
          const dep = {
            id,
            environment: "production",
            url: `https://${id}.${p.name}.pages.dev`,
            created_on: new Date().toISOString(),
            latest_stage: { name: "deploy", status: "success" },
            deployment_trigger: { metadata: { branch: fields.branch || "main", commit_message: fields.commit_message || "" } },
            manifest: fields.manifest ? JSON.parse(fields.manifest) : {},
          };
          p.deployments.unshift(dep);
          p.canonical_id = dep.id;
          return ok(res, dep);
        }
        const depMatch = /^deployments\/([^/]+)(?:\/(rollback))?$/.exec(sub || "");
        if (depMatch) {
          const [, depId, action] = depMatch;
          const dep = p.deployments.find((d) => d.id === depId);
          if (!dep) return err(res, 404, "Deployment not found");
          if (!action && method === "GET") return ok(res, dep);
          if (!action && method === "DELETE") {
            if (p.canonical_id === dep.id) return err(res, 400, "Cannot delete active production deployment");
            p.deployments = p.deployments.filter((d) => d.id !== depId);
            return ok(res, null);
          }
          if (action === "rollback" && method === "POST") {
            if (dep.environment !== "production" || dep.latest_stage?.status !== "success") {
              return err(res, 400, "Cannot rollback to non-production or failed deployment");
            }
            p.canonical_id = dep.id;
            return ok(res, dep);
          }
        }
      }

      return err(res, 404, "Not found");
    } catch (e) {
      return err(res, 500, e.message || "Internal stub error");
    }
  });

  function projectView(p) {
    const canonical = p.deployments.find((d) => d.id === p.canonical_id) || null;
    return {
      id: p.id,
      name: p.name,
      subdomain: p.subdomain,
      production_branch: p.production_branch,
      created_on: p.created_on,
      domains: p.domains,
      build_config: p.build_config,
      canonical_deployment: canonical,
      latest_deployment: p.deployments[0] || null,
    };
  }

  await new Promise((resolve) => server.listen(options.port || 0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    port: address.port,
    state,
    acct,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
