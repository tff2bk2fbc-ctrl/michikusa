-- PDF仕様: プロフィールの印を本人がタップして変更できるようにする。
-- 外部画像URLを持たず、監査可能な内蔵アイコンだけを保存する。
ALTER TABLE users ADD COLUMN profile_icon TEXT NOT NULL DEFAULT 'pin'
  CHECK (profile_icon IN ('pin','camera','mountain','tree','star','moon','wave','flower'));
