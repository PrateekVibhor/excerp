-- Migration 013 (Plan 16, part 5): the reference library and skill categories in the database, and category coverage. New tables only; nothing existing is changed or removed.
BEGIN;

-- Plan 16, part 5: the reference library and the skill categories live in the database (the files are an export for backup and audit), and each category's
-- coverage by the library is rated and stored against the library version it was rated at, so improvement over time can be measured.
CREATE TABLE IF NOT EXISTS library_sources (
  id                text        PRIMARY KEY,
  scope             text        NOT NULL,                          -- 'shared', or the role folder the entry came from
  position          integer     NOT NULL DEFAULT 0,                -- order within its file, kept so an export reads like the original
  name              text        NOT NULL,
  url               text        NOT NULL,
  tier              integer     NOT NULL CHECK (tier IN (1, 2, 3)),
  layer             text        NOT NULL,
  access            text        NOT NULL CHECK (access IN ('open', 'free_account')),
  perspective       text        NOT NULL,
  pipeline_readable boolean     NOT NULL,
  applies_to        text[]      NOT NULL DEFAULT '{}',
  status            text        NOT NULL CHECK (status IN ('active', 'candidate_other_roles', 'suspended', 'removed', 'flagged')),
  next_check        date,
  entry             jsonb       NOT NULL,                          -- the whole record exactly as in the files; the columns above are copied from it for queries
  origin            text        NOT NULL DEFAULT 'seed' CHECK (origin IN ('seed', 'finder')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS library_sources_status_idx ON library_sources (status);
CREATE TABLE IF NOT EXISTS library_role_files (
  role_slug            text  PRIMARY KEY,
  role                 text  NOT NULL,
  built                text  NOT NULL DEFAULT '',
  uses_shared          jsonb NOT NULL DEFAULT '[]'::jsonb,
  checked_and_excluded jsonb NOT NULL DEFAULT '[]'::jsonb,
  extra                jsonb NOT NULL DEFAULT '{}'::jsonb             -- any other keys the role's file carries
);
CREATE TABLE IF NOT EXISTS library_meta (
  key   text  PRIMARY KEY,
  value jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS library_changes (                       -- one row per change to the library; the latest version number is the library's version
  version    bigserial   PRIMARY KEY,
  source_id  text,
  kind       text        NOT NULL CHECK (kind IN ('added', 'changed', 'status')),
  summary    text        NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS library_source_index (                  -- which sources have been read to find what they discuss (the text itself is never kept)
  source_id  text        PRIMARY KEY REFERENCES library_sources (id) ON DELETE CASCADE,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  text_chars integer     NOT NULL DEFAULT 0,
  error      text
);
CREATE TABLE IF NOT EXISTS skill_taxonomies (
  role_slug text  PRIMARY KEY,
  role      text  NOT NULL,
  note      text  NOT NULL DEFAULT '',
  tools     jsonb NOT NULL DEFAULT '[]'::jsonb,
  examples  jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE TABLE IF NOT EXISTS skill_categories (
  role_slug   text  NOT NULL,
  id          text  NOT NULL,
  position    integer NOT NULL DEFAULT 0,
  name        text  NOT NULL,
  description text  NOT NULL,
  aliases     jsonb NOT NULL DEFAULT '[]'::jsonb,
  status      text  NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'proposed', 'merged')),
  PRIMARY KEY (role_slug, id)
);
CREATE TABLE IF NOT EXISTS library_source_categories (             -- a source discusses a category this many times (counted when the source was read)
  source_id   text    NOT NULL REFERENCES library_sources (id) ON DELETE CASCADE,
  role_slug   text    NOT NULL,
  category_id text    NOT NULL,
  hits        integer NOT NULL CHECK (hits > 0),
  verdict     text    NOT NULL DEFAULT 'unchecked' CHECK (verdict IN ('unchecked', 'teaches', 'mentions')),  -- whether the source teaches the category or only uses its words; only "teaches" counts toward coverage
  PRIMARY KEY (source_id, role_slug, category_id)
);
CREATE TABLE IF NOT EXISTS category_coverage (
  role_slug       text        NOT NULL,
  category_id     text        NOT NULL,
  library_version bigint      NOT NULL,
  band            text        NOT NULL CHECK (band IN ('strong', 'thin', 'missing')),
  source_ids      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  min_hits        integer     NOT NULL,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_slug, category_id, library_version)
);

COMMIT;
