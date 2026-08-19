-- 規約同意の監査記録。写真、位置、表示名などは重複保存しない。
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS legal_acceptances (
  user_id TEXT NOT NULL,
  terms_version TEXT NOT NULL,
  privacy_version TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, terms_version, privacy_version),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS legal_acceptances_recorded
  ON legal_acceptances(recorded_at DESC);
