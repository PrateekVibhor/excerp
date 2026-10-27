-- Plan 15, part 2: message requests and conversations, and the moderator's log.
--
-- Run once on a database that already has migrations 006 and 007:
--   psql "$DATABASE_URL" -f migrations/008_messages.sql
-- It only adds one nullable column, a sequence and tables, so nothing existing changes, and running it again changes nothing.
-- Take a backup first (pg_dump), as for the earlier migrations.
BEGIN;

-- Plan 15, part 2: message requests and conversations, and the moderator's log.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS banned_at timestamptz;  -- set by the moderator: cannot sign in again

-- One ordering for everything a reader's inbox can poll for.
CREATE SEQUENCE IF NOT EXISTS inbox_seq;

-- A request is the first message of a conversation. It opens when the person asked accepts. Both people are set to null if their
-- account is deleted: what was sent stays with the other person, without the name.
CREATE TABLE IF NOT EXISTS conversations (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  initiator_id uuid        REFERENCES accounts (id) ON DELETE SET NULL,
  recipient_id uuid        REFERENCES accounts (id) ON DELETE SET NULL,
  article_id   uuid        REFERENCES articles (id),
  state        text        NOT NULL CHECK (state IN ('request', 'open', 'declined', 'expired')),
  created_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  state_seq    bigint      NOT NULL DEFAULT nextval('inbox_seq')
);
-- Two people have one conversation at a time, whatever happened to it, until its messages are gone.
CREATE UNIQUE INDEX IF NOT EXISTS conversations_pair_key ON conversations (LEAST(initiator_id, recipient_id), GREATEST(initiator_id, recipient_id))
  WHERE initiator_id IS NOT NULL AND recipient_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversations_initiator_idx ON conversations (initiator_id, created_at);
CREATE INDEX IF NOT EXISTS conversations_recipient_idx ON conversations (recipient_id);

CREATE TABLE IF NOT EXISTS messages (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id       uuid        NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  sender_id             uuid        REFERENCES accounts (id) ON DELETE SET NULL,
  recipient_id          uuid        REFERENCES accounts (id) ON DELETE SET NULL,
  subject               text        NOT NULL DEFAULT '' CHECK (char_length(subject) <= 120),
  body                  text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  body_key              text        NOT NULL,  -- the body in lower case with its spaces squeezed, hashed: to stop the same text going to many people
  created_at            timestamptz NOT NULL,
  expires_at            timestamptz NOT NULL,  -- twelve months after it was sent
  read_at               timestamptz,
  hidden_by_sender_at   timestamptz,
  hidden_by_recipient_at timestamptz,
  seq                   bigint      NOT NULL DEFAULT nextval('inbox_seq')
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS messages_sender_idx ON messages (sender_id, created_at);
CREATE INDEX IF NOT EXISTS messages_repeat_idx ON messages (sender_id, body_key, created_at);
CREATE INDEX IF NOT EXISTS messages_recipient_idx ON messages (recipient_id);
CREATE INDEX IF NOT EXISTS messages_expires_idx ON messages (expires_at);

-- What the moderator and the automatic checks have done. It holds only a public id, which is random and means nothing outside the app.
CREATE TABLE IF NOT EXISTS moderation_log (
  id         bigserial   PRIMARY KEY,
  account_id uuid        REFERENCES accounts (id) ON DELETE SET NULL,
  public_id  uuid,
  action     text        NOT NULL,
  reason     text        NOT NULL DEFAULT '',
  actor      text        NOT NULL CHECK (actor IN ('owner', 'system')),
  detail     jsonb,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS moderation_log_created_idx ON moderation_log (created_at DESC);

COMMIT;
