-- Feature 11: Google Sign-In with an allow-list.
--
-- Run once on a database created from an older schema.sql:
--   psql "$DATABASE_URL" -f migrations/004_auth.sql
-- It only adds tables, so nothing existing is touched, and running it again changes nothing.
BEGIN;

-- Feature 11: Google Sign-In with an allow-list.
-- The people who may use the app. The owner edits this with `npm run allow`. Emails are kept lower case.
CREATE TABLE IF NOT EXISTS allowed_emails (
  email    text        PRIMARY KEY CHECK (email = lower(email) AND char_length(email) <= 254),
  added_at timestamptz NOT NULL DEFAULT now()
);

-- Readers who signed in with Google and were not on the list: the email and when, nothing else.
CREATE TABLE IF NOT EXISTS access_requests (
  email              text        PRIMARY KEY CHECK (email = lower(email) AND char_length(email) <= 254),
  first_requested_at timestamptz NOT NULL,
  last_requested_at  timestamptz NOT NULL
);

-- A signed-in, approved reader. Only the hash of the token is stored, never the token.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text        PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),  -- SHA-256, lower-case hex
  email      text        NOT NULL CHECK (email = lower(email)),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);

COMMIT;
