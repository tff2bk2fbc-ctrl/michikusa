-- Account deletion, user reports, and production communication monitor.
-- The monitor stores delivery states only; it never stores a device token or
-- precise user coordinates in its audit rows.
PRAGMA foreign_keys = ON;

-- reports is part of the original production schema. Extend it in place so
-- existing moderation IDs and status values remain valid.
ALTER TABLE reports ADD COLUMN client_operation_id TEXT;
ALTER TABLE reports ADD COLUMN updated_at INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS reports_reporter_operation
  ON reports(reporter_id, client_operation_id)
  WHERE client_operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS reports_status_created
  ON reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_post_created
  ON reports(post_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_user_created
  ON reports(target_user, created_at DESC);

-- This job deliberately has no users FK: the audit row must survive the
-- deletion it records. user_id is erased as soon as the purge completes.
CREATE TABLE IF NOT EXISTS account_deletion_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  user_id_hash TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google','apple','phone')),
  provider_uid_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('prepared','auth_deleted','data_pending','completed','failed')),
  requested_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  last_error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS account_deletion_jobs_pending
  ON account_deletion_jobs(status, updated_at);

CREATE TABLE IF NOT EXISTS account_deletion_files (
  job_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  PRIMARY KEY (job_id, object_key),
  FOREIGN KEY (job_id) REFERENCES account_deletion_jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS communication_monitor_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('running','push_accepted','received','opened','confirmed','failed','expired')),
  steps_json TEXT NOT NULL DEFAULT '{}',
  push_accepted_at INTEGER,
  received_at INTEGER,
  opened_at INTEGER,
  confirmed_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS communication_monitor_user_created
  ON communication_monitor_runs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS communication_monitor_expiry
  ON communication_monitor_runs(expires_at, status);

CREATE TABLE IF NOT EXISTS communication_monitor_receipts (
  run_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('received','opened','confirmed')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, user_id, event),
  FOREIGN KEY (run_id) REFERENCES communication_monitor_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Every temporary row produced by a monitor run is listed here so the cron
-- cleanup can remove only monitor-owned data and never touch user content.
CREATE TABLE IF NOT EXISTS communication_monitor_artifacts (
  run_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN
    ('post','friendship','conversation','message','like','flash','notification','r2_object')),
  artifact_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, artifact_type, artifact_id),
  FOREIGN KEY (run_id) REFERENCES communication_monitor_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS communication_monitor_artifact_cleanup
  ON communication_monitor_artifacts(created_at, artifact_type);
