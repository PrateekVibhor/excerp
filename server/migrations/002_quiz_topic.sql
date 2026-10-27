-- Feature 8: a quiz and a topic for each article. Both are optional, so every stored article stays valid.
--
-- Run once on a database created from an older schema.sql:
--   psql "$DATABASE_URL" -f migrations/002_quiz_topic.sql
-- Running it again changes nothing.
BEGIN;

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS quiz jsonb,
  ADD COLUMN IF NOT EXISTS topic text;

COMMIT;
