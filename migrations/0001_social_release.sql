-- Spota release social backend
-- Existing posts/users/friendships remain the source of truth for privacy.
PRAGMA foreign_keys = ON;

-- Announcements are emitted only after the final visibility, delay and
-- server-side image moderation have all succeeded.
ALTER TABLE posts ADD COLUMN social_announced_at INTEGER;
ALTER TABLE posts ADD COLUMN client_operation_id TEXT;
ALTER TABLE photos ADD COLUMN moderation_state TEXT
  CHECK (moderation_state IS NULL OR moderation_state IN ('legacy','ok','bad','error','not-required'));
ALTER TABLE photos ADD COLUMN moderation_view_state TEXT
  CHECK (moderation_view_state IS NULL OR moderation_view_state IN ('legacy','ok','bad','error','not-required'));
ALTER TABLE photos ADD COLUMN moderation_thumb_state TEXT
  CHECK (moderation_thumb_state IS NULL OR moderation_thumb_state IN ('legacy','ok','bad','error','not-required'));
CREATE UNIQUE INDEX IF NOT EXISTS posts_user_client_operation
  ON posts(user_id, client_operation_id) WHERE client_operation_id IS NOT NULL;

-- Old rows predate server-persisted moderation proof. Keep the memories but
-- fail closed: their owner must explicitly republish after a fresh check.
UPDATE photos SET moderation_state='legacy' WHERE moderation_state IS NULL;
UPDATE photos SET moderation_view_state='legacy',moderation_thumb_state='legacy';
UPDATE posts SET visibility='private',social_announced_at=NULL
 WHERE visibility<>'private' AND EXISTS (
   SELECT 1 FROM photos ph WHERE ph.post_id=posts.id AND ph.moderation_state<>'ok'
 );

CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL,
  followee_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id),
  FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (followee_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS follows_followee_created
  ON follows(followee_id, created_at DESC);

CREATE TABLE IF NOT EXISTS post_likes (
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS post_likes_user_created
  ON post_likes(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS post_comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  client_operation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS post_comments_post_created
  ON post_comments(post_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS post_comments_user_created
  ON post_comments(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS post_comments_user_operation
  ON post_comments(post_id, user_id, client_operation_id);

CREATE TABLE IF NOT EXISTS post_hashtags (
  post_id TEXT NOT NULL,
  tag_key TEXT NOT NULL,
  tag_label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, tag_key),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS post_hashtags_tag_created
  ON post_hashtags(tag_key, created_at DESC);
CREATE INDEX IF NOT EXISTS post_hashtags_recent_tag
  ON post_hashtags(created_at DESC, tag_key);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  pair_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_updated
  ON conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  last_read_at INTEGER NOT NULL DEFAULT 0,
  last_read_id TEXT NOT NULL DEFAULT '',
  hidden_at INTEGER,
  PRIMARY KEY (conversation_id, user_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS conversation_members_user
  ON conversation_members(user_id, conversation_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL,
  client_operation_id TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS messages_conversation_created
  ON messages(conversation_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS messages_sender_operation
  ON messages(conversation_id, sender_id, client_operation_id)
  WHERE client_operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_sender ON messages(sender_id);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  actor_id TEXT,
  kind TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  dedupe_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS notifications_user_created
  ON notifications(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS notifications_user_unread
  ON notifications(user_id, read_at, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_actor ON notifications(actor_id);

CREATE TABLE IF NOT EXISTS social_albums (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'friends', 'public')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS social_albums_user_updated
  ON social_albums(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS social_album_items (
  album_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (album_id, post_id),
  FOREIGN KEY (album_id) REFERENCES social_albums(id) ON DELETE CASCADE,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS social_album_items_album_order
  ON social_album_items(album_id, sort_order, created_at);
CREATE INDEX IF NOT EXISTS social_album_items_post ON social_album_items(post_id);

CREATE TABLE IF NOT EXISTS share_links (
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'album')),
  target_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS share_links_owner_created
  ON share_links(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS share_links_target
  ON share_links(target_type, target_id);
CREATE INDEX IF NOT EXISTS posts_active_created
  ON posts(created_at DESC, id DESC) WHERE deleted_at IS NULL;
