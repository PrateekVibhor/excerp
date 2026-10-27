-- Migration 015 (Plan 16, part 7): list mode. Adds a mode column to courses (default 'narrow', so every existing course is unchanged), widens the two one-course-per-role indexes to include it, and adds two tables.
BEGIN;

-- Plan 16, part 7: list mode. A course is either "narrow" (written chapters, as before) or "list" (a sequenced list of concepts, each with real links and a coverage
-- rating, no written text). A role and industry can have one of each. A list course keeps, per published version, its concepts (display name, order, rating)
-- and the links shown for each.
ALTER TABLE courses ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'narrow' CHECK (mode IN ('narrow', 'list'));
DROP INDEX IF EXISTS courses_shared_role_industry_key;
DROP INDEX IF EXISTS courses_private_role_industry_key;
CREATE UNIQUE INDEX IF NOT EXISTS courses_shared_role_industry_key ON courses (role_id, industry, mode) WHERE visibility = 'shared' AND status IN ('building', 'ready', 'withdrawn');
CREATE UNIQUE INDEX IF NOT EXISTS courses_private_role_industry_key ON courses (owner_account_id, role_id, industry, mode) WHERE visibility = 'private' AND status IN ('building', 'ready', 'withdrawn');
CREATE TABLE IF NOT EXISTS list_concepts (
  course_id       uuid        NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  version_id      uuid        NOT NULL REFERENCES course_versions (id) ON DELETE CASCADE,
  concept_id      uuid        NOT NULL REFERENCES role_concepts (id) ON DELETE CASCADE,
  position        integer     NOT NULL CHECK (position >= 0),
  display_name    text        NOT NULL,
  band            text        NOT NULL CHECK (band IN ('strong', 'thin', 'missing')),
  library_links   integer     NOT NULL DEFAULT 0 CHECK (library_links >= 0),
  other_links     integer     NOT NULL DEFAULT 0 CHECK (other_links >= 0),
  library_version bigint,                                          -- the reference library's version when this was rated (none for a library kept in files)
  rated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (version_id, concept_id)
);
CREATE INDEX IF NOT EXISTS list_concepts_course_idx ON list_concepts (course_id, version_id, position);
CREATE TABLE IF NOT EXISTS list_links (
  id                bigserial PRIMARY KEY,
  course_id         uuid      NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  version_id        uuid      NOT NULL REFERENCES course_versions (id) ON DELETE CASCADE,
  concept_id        uuid      NOT NULL REFERENCES role_concepts (id) ON DELETE CASCADE,
  position          integer   NOT NULL CHECK (position >= 0),
  kind              text      NOT NULL CHECK (kind IN ('article', 'blog', 'video')),
  title             text      NOT NULL,
  source            text      NOT NULL DEFAULT '',
  url               text      NOT NULL,
  why               text      NOT NULL DEFAULT '',
  library_source_id text                                           -- set when the link is a vetted library source
);
CREATE INDEX IF NOT EXISTS list_links_concept_idx ON list_links (version_id, concept_id, position);

COMMIT;
