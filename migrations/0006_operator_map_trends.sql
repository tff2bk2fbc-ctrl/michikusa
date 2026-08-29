-- Operator-managed map trend words.
-- No email addresses, user content, device data, or external API credentials are stored here.
-- The Firebase UID allowlist is intentionally empty after migration and must be populated
-- through the documented owner-only D1 operation.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS trend_admins (
  firebase_uid TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('trend_editor')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS trend_admins_active
  ON trend_admins(enabled, revoked_at);

-- These are the current 0-3 words published above the map search field.
-- slot is the public display order; editing replaces the small current set atomically.
CREATE TABLE IF NOT EXISTS map_trend_terms (
  slot INTEGER PRIMARY KEY CHECK (slot BETWEEN 1 AND 3),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 48),
  query TEXT NOT NULL CHECK (length(query) BETWEEN 1 AND 80),
  source_label TEXT NOT NULL CHECK (length(source_label) BETWEEN 1 AND 48),
  observed_on TEXT NOT NULL CHECK (length(observed_on)=10),
  updated_by_firebase_uid TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The audit row contains only the operator UID, action, number of slots and timestamp.
-- It intentionally does not duplicate trend labels or any end-user data.
CREATE TABLE IF NOT EXISTS map_trend_audit (
  id TEXT PRIMARY KEY,
  firebase_uid TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('replace')),
  entry_count INTEGER NOT NULL CHECK (entry_count BETWEEN 0 AND 3),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS map_trend_audit_created
  ON map_trend_audit(created_at DESC);
