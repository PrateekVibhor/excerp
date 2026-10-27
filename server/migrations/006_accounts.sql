-- Plan 14: accounts, and the data tied to them (saved articles, verified articles, skip counts, claimed devices).
--
-- Run once on a database created from an older schema.sql:
--   psql "$DATABASE_URL" -f migrations/006_accounts.sql
-- It only adds tables and one nullable column, so nothing existing is touched, and running it again changes nothing.
-- Take a backup first (pg_dump), as for the earlier migrations.
BEGIN;

-- Plan 14: accounts. One per approved Google account, keyed by Google's stable `sub` (the email is only an attribute).
CREATE TABLE IF NOT EXISTS accounts (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub         text        NOT NULL UNIQUE,
  ref                text        NOT NULL UNIQUE CHECK (ref ~ '^EXC-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$'),  -- the short code shown in the app, derived from the sub
  email              text        NOT NULL CHECK (email = lower(email) AND char_length(email) <= 254),
  display_name       text        CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 40),
  claimed_name       text        CHECK (claimed_name IS NULL OR char_length(claimed_name) BETWEEN 1 AND 40),  -- the name an old device used, until a profile gives one
  industry           text,
  interests          jsonb,
  profile_updated_at timestamptz,
  profile_rev        bigint      NOT NULL DEFAULT 0,
  rev                bigint      NOT NULL DEFAULT 0,  -- counts the account's changes; a phone's sync cursor is a value of it
  sync_started_at    timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- A session belongs to an account. Sessions made before this have none.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES accounts (id) ON DELETE CASCADE;

-- Saved articles. A removed one stays as a marker so the other phones remove it too.
CREATE TABLE IF NOT EXISTS account_reading_list (
  account_id uuid        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  article_id uuid        NOT NULL REFERENCES articles (id),
  saved_at   timestamptz NOT NULL,
  removed    boolean     NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL,
  rev        bigint      NOT NULL,
  PRIMARY KEY (account_id, article_id)
);

-- Verified articles. Only ever added.
CREATE TABLE IF NOT EXISTS account_verifications (
  account_id  uuid        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  article_id  uuid        NOT NULL REFERENCES articles (id),
  verified_at timestamptz NOT NULL,
  topic       text        NOT NULL CHECK (char_length(topic) BETWEEN 1 AND 40),
  rev         bigint      NOT NULL,
  PRIMARY KEY (account_id, article_id)
);

-- How many times the account skipped an article: a counter, with no time, device or session.
CREATE TABLE IF NOT EXISTS account_skips (
  account_id uuid    NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  article_id uuid    NOT NULL REFERENCES articles (id),
  skips      integer NOT NULL CHECK (skips > 0),
  PRIMARY KEY (account_id, article_id)
);

-- An old random device id claimed by an account. The first claim wins.
CREATE TABLE IF NOT EXISTS device_claims (
  device_id  text PRIMARY KEY CHECK (device_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS device_claims_account_idx ON device_claims (account_id);

COMMIT;
