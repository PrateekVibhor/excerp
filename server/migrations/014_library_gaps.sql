-- Migration 014 (Plan 16, part 6): the gap queue and the source finder's candidates. New tables only; nothing existing is changed or removed.
BEGIN;

-- Plan 16, part 6: the gap queue and the source finder's candidates. A category the library covers thinly or not at all is a gap; the finder looks for sources
-- for it and records what it found and why each page passed or failed. In dry-run nothing found here is added to the library.
CREATE TABLE IF NOT EXISTS library_gaps (
  role_slug          text        NOT NULL,
  category_id        text        NOT NULL,
  status             text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'candidates_ready', 'filled', 'dead_end')),
  demand             integer     NOT NULL DEFAULT 1 CHECK (demand >= 1),
  attempts           integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  credits_spent      integer     NOT NULL DEFAULT 0 CHECK (credits_spent >= 0),
  first_seen_version bigint      NOT NULL,
  filled_version     bigint,
  last_attempt_at    timestamptz,
  note               text        NOT NULL DEFAULT '',
  PRIMARY KEY (role_slug, category_id)
);
CREATE TABLE IF NOT EXISTS library_candidates (
  id          bigserial   PRIMARY KEY,
  role_slug   text        NOT NULL,
  category_id text        NOT NULL,
  url         text        NOT NULL,
  name        text        NOT NULL DEFAULT '',
  status      text        NOT NULL CHECK (status IN ('proposed', 'rejected', 'admitted')),
  reason      text        NOT NULL DEFAULT '',
  tier        integer,
  admitted_version bigint,                                        -- the library version that added it, once it was admitted
  checks      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  draft       jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_slug, category_id, url)
);
CREATE INDEX IF NOT EXISTS library_candidates_status_idx ON library_candidates (role_slug, status);

COMMIT;
