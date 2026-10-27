-- Plan 15: readers who can see each other, blocks and reports.
--
-- Run once on a database that already has migration 006:
--   psql "$DATABASE_URL" -f migrations/007_readers.sql
-- It only adds columns (all off or empty), tables and indexes, so nothing existing changes, and running it again changes nothing.
-- Every reader starts hidden and with messaging off: nobody is shown to anyone until they choose to be.
-- Take a backup first (pg_dump), as for the earlier migrations.
BEGIN;

-- Plan 15: readers who can see each other, blocks and reports. Everything is off or empty to begin with.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS public_id          uuid        NOT NULL DEFAULT gen_random_uuid(),  -- what other readers see instead of any real id
  ADD COLUMN IF NOT EXISTS discoverable       boolean     NOT NULL DEFAULT false,              -- shown to other readers of the same article
  ADD COLUMN IF NOT EXISTS accepts_messages   boolean     NOT NULL DEFAULT false,              -- may be sent a message request (only while discoverable)
  ADD COLUMN IF NOT EXISTS adult_confirmed_at timestamptz,                                      -- the reader said they are 18 or older
  ADD COLUMN IF NOT EXISTS terms_accepted_at  timestamptz,                                      -- ... and accepted the Terms of Use
  ADD COLUMN IF NOT EXISTS suspended_until    timestamptz;                                      -- set by the moderator: hidden, and cannot message
CREATE UNIQUE INDEX IF NOT EXISTS accounts_public_id_key ON accounts (public_id);

-- Who a reader has blocked. Neither side sees the other; the blocked reader is never told.
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id uuid        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  blocked_id uuid        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS blocks_blocked_idx ON blocks (blocked_id);

-- Reports for the moderator. The snapshot is a frozen copy of what was reported, so changing a name or deleting a message does not
-- erase it. The people are unlinked (null) if their account is deleted; the snapshot stays.
CREATE TABLE IF NOT EXISTS reports (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid        REFERENCES accounts (id) ON DELETE SET NULL,
  reported_id uuid        REFERENCES accounts (id) ON DELETE SET NULL,
  message_id  uuid,       -- a reported message (added with messages)
  kind        text        NOT NULL CHECK (kind IN ('profile', 'message')),
  reason      text        NOT NULL CHECK (reason IN ('spam', 'harassment', 'hate', 'sexual', 'scam', 'other')),
  note        text        CHECK (note IS NULL OR char_length(note) <= 500),
  snapshot    jsonb       NOT NULL,
  status      text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at  timestamptz NOT NULL,
  handled_at  timestamptz,
  action      text
);
CREATE INDEX IF NOT EXISTS reports_open_idx ON reports (created_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS reports_pair_idx ON reports (reporter_id, reported_id, created_at);

-- The readers of an article and the real reader counts.
CREATE INDEX IF NOT EXISTS account_reading_list_article_idx ON account_reading_list (article_id) WHERE NOT removed;
CREATE INDEX IF NOT EXISTS account_verifications_article_idx ON account_verifications (article_id);

COMMIT;
