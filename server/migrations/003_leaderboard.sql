-- Feature 9: the leaderboard needs a table of players and a table of verifications.
--
-- Run once on a database created from an older schema.sql:
--   psql "$DATABASE_URL" -f migrations/003_leaderboard.sql
-- It only adds tables, so no article is touched, and running it again changes nothing.
BEGIN;

-- Feature 9: the leaderboard. No accounts: a player is a random device id the app makes on first use.
-- The pipeline never deletes articles, so a verification keeps pointing at a real one.
CREATE TABLE IF NOT EXISTS players (
  device_id    text        PRIMARY KEY CHECK (device_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),  -- a UUID, lower case
  display_name text        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 40 AND display_name = btrim(display_name)),
  updated_at   timestamptz NOT NULL
);

-- One row per device and article, so a verification sent twice counts once. A player's count is their rows.
CREATE TABLE IF NOT EXISTS verifications (
  device_id   text        NOT NULL REFERENCES players (device_id),
  article_id  uuid        NOT NULL REFERENCES articles (id),
  verified_at timestamptz NOT NULL,
  PRIMARY KEY (device_id, article_id)
);

COMMIT;
