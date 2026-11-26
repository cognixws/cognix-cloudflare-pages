-- 0.6.0 review fix: the Keep up to date keep-off decision is taken when a
-- change is prepared and stored on the operation (applied when it finishes).
ALTER TABLE operations ADD COLUMN keep_off TEXT;
