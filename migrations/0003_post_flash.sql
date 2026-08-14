-- PDF仕様: 公開済みの思い出を、1投稿につき1人1回だけ最大5人へ届ける。
-- 写真や座標は複製せず、通知は既存post_idだけを参照する。
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS post_flashes (
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  recipient_count INTEGER NOT NULL DEFAULT 0 CHECK (recipient_count BETWEEN 0 AND 5),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS post_flashes_user_created
  ON post_flashes(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS post_flashes_post_created
  ON post_flashes(post_id, created_at DESC);
