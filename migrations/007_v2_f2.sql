-- 0.6.0 (v2 F2): Keep up to date (D4), cached 7-day visits (D5), custom
-- domains on the 004 table (D6) and deleted version links (D10).
ALTER TABLE publications ADD COLUMN keep_updated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE publications ADD COLUMN sync_note TEXT;
ALTER TABLE publications ADD COLUMN sync_failed_version INTEGER;
ALTER TABLE deployments ADD COLUMN link_deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE operations ADD COLUMN keep_off TEXT;
ALTER TABLE publication_domains ADD COLUMN zone_name TEXT;
ALTER TABLE publication_domains ADD COLUMN dns TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE publication_domains ADD COLUMN txt_name TEXT;
ALTER TABLE publication_domains ADD COLUMN txt_value TEXT;
ALTER TABLE publication_domains ADD COLUMN created_at TEXT;
ALTER TABLE publication_domains ADD COLUMN checked_at TEXT;
CREATE TABLE visits (
 publication_id TEXT PRIMARY KEY REFERENCES publications(id),
 account_id TEXT NOT NULL,
 site_tag TEXT NOT NULL,
 days TEXT NOT NULL DEFAULT '[]',
 fetched_at TEXT NOT NULL
);
DROP INDEX one_active_operation;
CREATE UNIQUE INDEX one_active_operation ON operations(publication_id)
 WHERE status IN ('prepared','queued','creating','protecting','analytics','dns','uploading','deploying','verifying','removing','rolling-back','unknown');
DROP INDEX one_active_domain_operation;
CREATE UNIQUE INDEX one_active_domain_operation ON operations(
 json_extract(domain_plan,'$.account'),json_extract(domain_plan,'$.hostname')
) WHERE action IN ('domain-add','domain-remove') AND status IN ('prepared','queued','creating','protecting','analytics','dns','uploading','deploying','verifying','removing','rolling-back','unknown');
