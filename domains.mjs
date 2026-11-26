import { createHash, randomUUID } from "node:crypto";
import { RemoteError } from "./cloudflare.mjs";

// Custom domains (D6, 0.6.0). A subdomain is added to the Pages project first
// (a CNAME that exists before the domain answers 522), then its CNAME is
// created when the zone is in this Cloudflare account and the token may edit
// DNS; otherwise the person adds the exact record shown. Removal deletes the
// record before the domain (Cloudflare's order), so a name never points at a
// project that no longer claims it. Only records this extension created, and
// that still read as it wrote them, are ever deleted.

const RESERVED = /(^|\.)(pages\.dev|workers\.dev|cloudflareaccess\.com|cloudflare\.com|localhost|local|internal|example)$/i;
const NOW = () => new Date().toISOString();

export function normalizeHostname(raw) {
 const h = String(raw ?? "").trim().toLowerCase().replace(/\.$/, "");
 if (!h) throw new RemoteError("Enter a domain such as docs.example.com.", 400);
 if (h.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(h)) {
  throw new RemoteError("Enter a domain such as docs.example.com: letters, numbers, dashes and dots (a non-Latin name in its xn-- form).", 400);
 }
 if (RESERVED.test(h)) throw new RemoteError("Use a domain you own; Cloudflare's own and reserved names cannot be added.", 400);
 if (h.split(".").length < 3) {
  throw new RemoteError(`Use a subdomain such as www.${h} or docs.${h}. A whole domain needs its nameservers on Cloudflare, which Sites does not set up.`, 400);
 }
 return h;
}

// The DNS permission is optional: a 403 from a zone or DNS call means "this
// token cannot edit that DNS", never "the token is refused". It must not reach
// the service's token check (which would pause every site).
const denied = (e) => e instanceof RemoteError && e.status === 403;

const fingerprint = (r) => createHash("sha256").update(JSON.stringify({ id: r?.id, type: r?.type, name: String(r?.name || "").toLowerCase(), content: String(r?.content || "").toLowerCase().replace(/\.$/, "") })).digest("hex");
const pointsAt = (r, target) => r?.type === "CNAME" && String(r.content || "").toLowerCase().replace(/\.$/, "") === target;

// Cloudflare's validation text is not reflected; a TXT challenge it asks for
// is shown only when it reads as a DNS name and a printable value.
function txtOf(d) {
 const v = d?.validation_data;
 if (v?.method !== "txt" || !["pending", "initializing"].includes(v.status)) return { name: null, value: null };
 const name = typeof v.txt_name === "string" && /^[a-z0-9_.-]{1,253}$/i.test(v.txt_name) ? v.txt_name : null;
 const value = typeof v.txt_value === "string" && /^[\x21-\x7e]{1,255}$/.test(v.txt_value) ? v.txt_value : null;
 return name && value ? { name, value } : { name: null, value: null };
}
const STATUSES = new Set(["initializing", "pending", "active", "deactivated", "blocked", "error"]);

export class PublicationDomains {
 constructor({ db }) {
  this.db = db;
 }

 target(p) {
  return p.project + ".pages.dev";
 }
 list(p) {
  return this.db.prepare("SELECT * FROM publication_domains WHERE publication_id=? ORDER BY created_at, hostname").all(p.id);
 }
 row(account, hostname) {
  return this.db.prepare("SELECT * FROM publication_domains WHERE account_id=? AND hostname=?").get(account, hostname) || null;
 }

 // Which DNS path a new domain takes. Reads only: the zone lookup and the
 // records already on that name. A record this extension did not create is
 // never replaced.
 async plan(cf, p, hostname) {
  const target = this.target(p);
  let zone = null;
  let dns = "manual";
  let reason = "external";
  try {
   zone = await cf.findZone(hostname);
  } catch (e) {
   if (!(e instanceof RemoteError && e.status === 403)) throw e;
   reason = "zone-permission";
  }
  if (zone && zone.name === hostname) {
   throw new RemoteError(`${hostname} is a whole domain (its own zone). Use a subdomain such as www.${hostname}.`, 400);
  }
  if (zone) {
   reason = "zone";
   try {
    const records = await cf.dnsRecords(zone.id, hostname);
    if (records.some((r) => pointsAt(r, target))) dns = "existing";
    else if (records.length) {
     throw new RemoteError(`${hostname} already has a ${records[0].type || "DNS"} record in ${zone.name}. Change or delete it in Cloudflare first; Sites never replaces a record it did not create.`, 409);
    } else dns = "auto";
   } catch (e) {
    if (!(e instanceof RemoteError && e.status === 403)) throw e;
    reason = "dns-permission";
   }
  }
  return { account: p.account_id, hostname, target, zone, dns, reason };
 }

 // domain-add: the local row first, so a lost answer is settled by reading
 // the name back; then the Pages domain; then the CNAME when planned.
 async add(cf, p, op, setStatus) {
  const plan = JSON.parse(op.domain_plan);
  this.db
   .prepare("INSERT INTO publication_domains(id,publication_id,account_id,hostname,zone_id,zone_name,status,dns,created_at) VALUES(?,?,?,?,?,?,'adding',?,?) ON CONFLICT(account_id,hostname) DO NOTHING")
   .run(randomUUID(), p.id, plan.account, plan.hostname, plan.zone?.id || "", plan.zone?.name || null, plan.dns === "existing" ? "existing" : "manual", NOW());
  const row = this.row(plan.account, plan.hostname);
  if (!row || row.publication_id !== p.id) throw new RemoteError(`${plan.hostname} belongs to another site.`, 409);
  setStatus("creating");
  let d = await cf.getDomain(p.project, plan.hostname);
  if (!d) {
   try {
    d = await cf.addDomain(p.project, plan.hostname);
   } catch (e) {
    if (e instanceof RemoteError && [400, 409, 422].includes(e.status)) {
     throw new RemoteError(`Cloudflare refused ${plan.hostname}. It may already belong to another Cloudflare site or account.`, 409);
    }
    throw e;
   }
  }
  if (!d?.name || String(d.name).toLowerCase() !== plan.hostname) throw new RemoteError("Cloudflare did not confirm the domain.");
  this.record(row.id, d);
  if (plan.dns === "auto" && plan.zone?.id) {
   setStatus("dns");
   await this.link(cf, p, op, this.row(plan.account, plan.hostname), plan);
  }
  return this.row(plan.account, plan.hostname);
 }

 async link(cf, p, op, row, plan) {
  const target = this.target(p);
  const marker = "COGNIX[WS] Sites " + op.id;
  let records;
  try {
   records = await cf.dnsRecords(plan.zone.id, plan.hostname);
  } catch (e) {
   if (!denied(e)) throw e;
   this.db.prepare("UPDATE publication_domains SET dns='manual' WHERE id=?").run(row.id);
   return;
  }
  let rec = records.find((r) => pointsAt(r, target)) || null;
  let owned = Boolean(rec && String(rec.comment || "").includes(op.id));
  let dns = rec ? (owned ? "auto" : "existing") : "manual";
  if (!rec && records.length) {
   dns = "conflict";
  } else if (!rec) {
   try {
    rec = await cf.createDnsRecord(plan.zone.id, { type: "CNAME", name: plan.hostname, content: target, proxied: true, ttl: 1, comment: marker });
    if (!rec?.id) throw new RemoteError("Cloudflare did not identify the DNS record.");
    owned = true;
    dns = "auto";
   } catch (e) {
    if (!denied(e)) throw e;
    dns = "manual";
   }
  }
  this.db
   .prepare("UPDATE publication_domains SET dns=?,dns_id=?,dns_owned=?,dns_fingerprint=? WHERE id=?")
   .run(dns, owned ? rec.id : null, owned ? 1 : 0, owned ? fingerprint(rec) : null, row.id);
 }

 record(rowId, d) {
  const status = STATUSES.has(d?.status) ? d.status : "pending";
  const txt = txtOf(d);
  this.db
   .prepare("UPDATE publication_domains SET domain_id=?,status=?,txt_name=?,txt_value=?,checked_at=?,verified_at=CASE WHEN ?='active' THEN COALESCE(verified_at,?) ELSE verified_at END WHERE id=?")
   .run(d?.id || null, status, txt.name, txt.value, NOW(), status, NOW(), rowId);
 }

 // Check now. A failed validation is retried (PATCH); otherwise it is read.
 async refresh(cf, p, row, retry = false) {
  const d = retry && ["error", "deactivated", "blocked"].includes(row.status) ? await cf.retryDomain(p.project, row.hostname) : await cf.getDomain(p.project, row.hostname);
  if (!d) {
   this.db.prepare("UPDATE publication_domains SET status='missing',checked_at=? WHERE id=?").run(NOW(), row.id);
   return;
  }
  this.record(row.id, d);
 }

 // Deletes the CNAME this extension created when it still reads as written.
 // A record changed by someone else is left alone and said so.
 async unlink(cf, row) {
  if (!row.dns_owned || !row.dns_id || !row.zone_id) return { left: false };
  let left = false;
  let reason = "";
  try {
   const rec = await cf.getDnsRecord(row.zone_id, row.dns_id);
   if (rec && fingerprint(rec) === row.dns_fingerprint) await cf.deleteDnsRecord(row.zone_id, row.dns_id);
   else if (rec) {
    left = true;
    reason = "changed";
   }
  } catch (e) {
   // The token lost its DNS permission: the record stays and the person is told.
   if (!denied(e)) throw e;
   left = true;
   reason = "permission";
  }
  this.db.prepare("UPDATE publication_domains SET dns_owned=0,dns_id=NULL,dns_fingerprint=NULL,dns=? WHERE id=?").run(left ? "existing" : "manual", row.id);
  return { left, reason };
 }

 // What the person must do about a record Sites could not delete.
 leftMessage(p, row, reason) {
  const zone = row.zone_name ? ` in ${row.zone_name}` : "";
  return reason === "permission"
   ? `The token cannot edit DNS${zone} any more, so the CNAME record ${row.hostname} → ${this.target(p)} was left in place. Delete it in Cloudflare so the name does not point to a site that no longer claims it.`
   : `The DNS record for ${row.hostname} was changed outside Sites, so it was left in place.`;
 }

 async remove(cf, p, row) {
  const { left, reason } = await this.unlink(cf, row);
  await cf.removeDomain(p.project, row.hostname);
  this.db.prepare("DELETE FROM publication_domains WHERE id=?").run(row.id);
  return { left, message: left ? this.leftMessage(p, row, reason) : "" };
 }

 // Before a site's project is deleted: every record it created goes first.
 // Returns what the person must still delete by hand.
 async unlinkAll(cf, p) {
  const messages = [];
  for (const row of this.list(p)) {
   const { left, reason } = await this.unlink(cf, row);
   if (left && reason === "permission") messages.push(this.leftMessage(p, row, reason));
  }
  return messages;
 }
 forget(p) {
  this.db.prepare("DELETE FROM publication_domains WHERE publication_id=?").run(p.id);
 }

 // The words the confirmations and Manage site use for one domain.
 serialize(p, row) {
  const target = this.target(p);
  const state =
   row.status === "active"
    ? "active"
    : row.status === "adding"
      ? "adding"
      : ["error", "blocked", "deactivated", "missing"].includes(row.status)
        ? "attention"
        : "waiting";
  return {
   hostname: row.hostname,
   state,
   status: row.status,
   dns: row.dns,
   zone: row.zone_name || null,
   record: { type: "CNAME", name: row.hostname, content: target },
   txt: row.txt_name && row.txt_value ? { type: "TXT", name: row.txt_name, content: row.txt_value } : null,
   ownedRecord: Boolean(row.dns_owned),
   checkedAt: row.checked_at || null,
   verifiedAt: row.verified_at || null,
   url: state === "active" ? `https://${row.hostname}/` : null,
  };
 }
}
