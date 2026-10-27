-- Plan 16: narrative role courses (phase 2, step 1: the tables).
--
-- Run once on a database that already has migrations 006 to 008:
--   psql "$DATABASE_URL" -f migrations/009_courses.sql
-- It only adds 29 tables and their indexes. The one later change is the version table's link back to courses, added once
-- courses exists because the two refer to each other; the statement checks first, so running the file again changes nothing.
-- No existing table is changed, and nothing is on until the courses switch is turned on in code.
-- Take a backup first (pg_dump), as for the earlier migrations.
BEGIN;

-- Plan 16: narrative role courses. A role's evidence (postings and the skills they ask for), the courses built from it, their versions,
-- what readers do with them, and the flags, changes and settings around them. 29 tables, all new; nothing existing is changed.
-- Spec 16, section 4. Everything here is off until the courses switch (course_settings 'courses_off') is turned on in code.

-- Roles are normalized (lower case, trimmed). A different name for the same role is an alias, not a second role.
CREATE TABLE IF NOT EXISTS roles (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL UNIQUE CHECK (name = lower(btrim(name)) AND char_length(name) BETWEEN 1 AND 120),
  description text        NOT NULL DEFAULT '',  -- a short model-written definition, used to nominate similar roles
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_aliases (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id      uuid        NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  title_seen   text        NOT NULL CHECK (title_seen = lower(btrim(title_seen)) AND char_length(title_seen) BETWEEN 1 AND 200),
  times_seen   integer     NOT NULL DEFAULT 1 CHECK (times_seen >= 1),
  last_seen_at timestamptz NOT NULL,
  UNIQUE (role_id, title_seen)
);

-- The single list of companies discovery searches, shared by every role. It holds links and counts only, never page text.
CREATE TABLE IF NOT EXISTS tracked_companies (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  employer        text        NOT NULL,
  domain          text        NOT NULL UNIQUE CHECK (domain = lower(domain)),
  careers_url     text,
  status          text        NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'trusted', 'blocked')),
  successes       integer     NOT NULL DEFAULT 0 CHECK (successes >= 0),
  failures        integer     NOT NULL DEFAULT 0 CHECK (failures >= 0),
  last_checked_at timestamptz,
  last_matched_at timestamptz,
  added_by        text        NOT NULL CHECK (added_by IN ('seed', 'search', 'owner')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- A skill of a role: the unit of reuse. Its criticality is the share of the role's current postings that ask for it, or null
-- when the evidence does not support one. A private concept exists only for a course built with a pasted description.
CREATE TABLE IF NOT EXISTS role_concepts (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id           uuid        NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  name              text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  terms             jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- the names the course texts actually use; an older term stays when a newer one replaces it
  plain_explanation text        NOT NULL DEFAULT '',
  mentions          integer     NOT NULL DEFAULT 0 CHECK (mentions >= 0),
  of_postings       integer     NOT NULL DEFAULT 0 CHECK (of_postings >= 0),
  criticality       text        CHECK (criticality IN ('high', 'medium', 'low')),
  derived_from      uuid        REFERENCES role_concepts (id) ON DELETE SET NULL,  -- a concept of a similar role it was reused from
  visibility        text        NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared', 'private')),
  owner_account_id  uuid        REFERENCES accounts (id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((visibility = 'private') = (owner_account_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS role_concepts_shared_name_key ON role_concepts (role_id, lower(name)) WHERE visibility = 'shared';
CREATE UNIQUE INDEX IF NOT EXISTS role_concepts_private_name_key ON role_concepts (owner_account_id, role_id, lower(name)) WHERE visibility = 'private';

-- A posting (or a pasted description) as evidence. The page text is not stored: a pasted description lives only in course_inputs.
CREATE TABLE IF NOT EXISTS sources (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id               uuid        NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  role_title            text        NOT NULL CHECK (char_length(role_title) BETWEEN 1 AND 300),  -- the exact title used at that company
  designation           text,
  company               text        NOT NULL,
  url                   text,                              -- the original posting or application page; null only for a paste
  origin                text        NOT NULL CHECK (origin IN ('user_paste', 'user_url', 'research')),
  found_via             text        NOT NULL CHECK (found_via IN ('tracked_search', 'open_search', 'user')),
  match                 text        NOT NULL CHECK (match IN ('exact', 'alias', 'similar')),
  counts_for_criticality boolean    NOT NULL DEFAULT false,
  visibility            text        NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared', 'private')),
  owner_account_id      uuid        REFERENCES accounts (id) ON DELETE CASCADE,
  posted_at             timestamptz,
  status                text        NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'current', 'closed', 'dropped')),
  last_seen_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (url IS NOT NULL OR origin = 'user_paste'),
  CHECK ((visibility = 'private') = (origin = 'user_paste')),                       -- only a paste is private
  CHECK ((visibility = 'private') = (owner_account_id IS NOT NULL)),
  CHECK (NOT counts_for_criticality OR origin IN ('research', 'user_url'))           -- a paste never counts
);
CREATE UNIQUE INDEX IF NOT EXISTS sources_shared_url_key ON sources (role_id, url) WHERE visibility = 'shared' AND url IS NOT NULL;
CREATE INDEX IF NOT EXISTS sources_role_status_idx ON sources (role_id, status);

-- The skills a source asks for, one row each, so mentions are counted from data.
CREATE TABLE IF NOT EXISTS source_skills (
  source_id  uuid NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  concept_id uuid NOT NULL REFERENCES role_concepts (id) ON DELETE CASCADE,
  PRIMARY KEY (source_id, concept_id)
);
CREATE INDEX IF NOT EXISTS source_skills_concept_idx ON source_skills (concept_id);

-- Claims already checked, so reuse does not check them again. Claims in the four sensitive categories are always re-checked.
CREATE TABLE IF NOT EXISTS concept_claims (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id uuid        NOT NULL REFERENCES role_concepts (id) ON DELETE CASCADE,
  claim      text        NOT NULL,
  category   text        CHECK (category IN ('law', 'safety', 'money', 'health')),
  status     text        NOT NULL DEFAULT 'verified' CHECK (status IN ('verified')),
  source_url text,
  verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS concept_claims_concept_idx ON concept_claims (concept_id);

CREATE TABLE IF NOT EXISTS resources (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id uuid        NOT NULL REFERENCES role_concepts (id) ON DELETE CASCADE,
  kind       text        NOT NULL CHECK (kind IN ('article', 'blog', 'video')),
  title      text        NOT NULL,
  source     text        NOT NULL DEFAULT '',
  url        text        NOT NULL,
  why        text        NOT NULL DEFAULT '',
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS resources_concept_idx ON resources (concept_id);

-- A course is built in versions: a new version is made beside the live one and replaces it in one transaction. The link from a
-- version back to its course is added after courses exists (the two refer to each other).
CREATE TABLE IF NOT EXISTS course_versions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id    uuid        NOT NULL,
  version      integer     NOT NULL CHECK (version >= 1),
  status       text        NOT NULL CHECK (status IN ('building', 'published', 'superseded', 'failed')),
  run_id       bigint,     -- the run that built it
  model        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (course_id, version),
  UNIQUE (course_id, id),
  CHECK (status <> 'published' OR published_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS course_versions_one_published_key ON course_versions (course_id) WHERE status = 'published';
CREATE UNIQUE INDEX IF NOT EXISTS course_versions_one_building_key ON course_versions (course_id) WHERE status = 'building';  -- one build at a time

-- A course is for a role. Several attempts may be pending (finding sources, or awaiting approval) but only one shared course per role
-- is built, ready or withdrawn at a time. A private course exists only for a pasted description. Status is the publish state; the
-- stages of a build are in course_runs.
CREATE TABLE IF NOT EXISTS courses (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id          uuid        NOT NULL REFERENCES roles (id),
  title            text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  visibility       text        NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared', 'private')),
  owner_account_id uuid        REFERENCES accounts (id) ON DELETE CASCADE,  -- a private course goes with its owner
  requested_by     uuid        REFERENCES accounts (id) ON DELETE SET NULL, -- who started it; a pending course is visible to this account only
  status           text        NOT NULL DEFAULT 'finding_sources' CHECK (status IN ('finding_sources', 'awaiting_approval', 'building', 'ready', 'failed', 'cancelled', 'withdrawn')),
  failure_reason   text,
  withdrawn_at     timestamptz,
  withdrawal_note  text,       -- shown to readers
  pool_size        integer     NOT NULL DEFAULT 0 CHECK (pool_size >= 0),  -- postings in the evidence when last built
  evidence_thin    boolean     NOT NULL DEFAULT false,                     -- fewer than eight postings remain
  replace_count    integer     NOT NULL DEFAULT 0 CHECK (replace_count BETWEEN 0 AND 2),
  approved_at      timestamptz,
  generated_at     timestamptz,
  last_checked_at  timestamptz,
  next_check_at    timestamptz,
  model            text,
  published_version uuid,      -- the live version, set only in the transaction that publishes it
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((visibility = 'private') = (owner_account_id IS NOT NULL)),
  CHECK (status <> 'withdrawn' OR withdrawn_at IS NOT NULL),
  CHECK (status <> 'ready' OR published_version IS NOT NULL),
  CONSTRAINT courses_published_version_fk FOREIGN KEY (id, published_version) REFERENCES course_versions (course_id, id)  -- the version must be this course's own
);
CREATE UNIQUE INDEX IF NOT EXISTS courses_shared_role_key ON courses (role_id) WHERE visibility = 'shared' AND status IN ('building', 'ready', 'withdrawn');
CREATE UNIQUE INDEX IF NOT EXISTS courses_private_role_key ON courses (owner_account_id, role_id) WHERE visibility = 'private' AND status IN ('building', 'ready', 'withdrawn');
CREATE INDEX IF NOT EXISTS courses_next_check_idx ON courses (next_check_at) WHERE status = 'ready';
CREATE INDEX IF NOT EXISTS courses_role_idx ON courses (role_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'course_versions_course_fk' AND conrelid = 'course_versions'::regclass) THEN
    ALTER TABLE course_versions ADD CONSTRAINT course_versions_course_fk FOREIGN KEY (course_id) REFERENCES courses (id) ON DELETE CASCADE;
  END IF;
END $$;

-- Cost and progress of each run (source finding, a generation, a refresh, a correction).
CREATE TABLE IF NOT EXISTS course_runs (
  id             bigserial   PRIMARY KEY,
  course_id      uuid        NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  version_id     uuid        REFERENCES course_versions (id) ON DELETE CASCADE,  -- null for source finding
  kind           text        NOT NULL CHECK (kind IN ('source_finding', 'generation', 'refresh', 'correction')),
  requested_by   uuid        REFERENCES accounts (id) ON DELETE SET NULL,
  stage          text        NOT NULL DEFAULT '',
  percent        integer     NOT NULL DEFAULT 0 CHECK (percent BETWEEN 0 AND 100),
  tavily_credits integer     NOT NULL DEFAULT 0 CHECK (tavily_credits >= 0),
  tokens_in      bigint      NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out     bigint      NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  started_at     timestamptz NOT NULL,
  finished_at    timestamptz,
  error          text,
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);
CREATE INDEX IF NOT EXISTS course_runs_course_idx ON course_runs (course_id, started_at DESC);

-- What the reader is shown and approves, and what the course teaches and why.
CREATE TABLE IF NOT EXISTS course_sources (
  course_id uuid NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  use       text NOT NULL CHECK (use IN ('pool', 'reader', 'not_used')),
  reason    text,
  state     text NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed', 'approved', 'replaced')),
  PRIMARY KEY (course_id, source_id),
  CHECK (use <> 'not_used' OR (reason IS NOT NULL AND reason <> ''))
);
CREATE INDEX IF NOT EXISTS course_sources_source_idx ON course_sources (source_id);

CREATE TABLE IF NOT EXISTS course_concepts (
  course_id          uuid    NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  concept_id         uuid    NOT NULL REFERENCES role_concepts (id) ON DELETE CASCADE,
  from_reader_source boolean NOT NULL DEFAULT false,  -- a concept only the reader's own link or paste asks for
  asked_by           jsonb   NOT NULL DEFAULT '[]'::jsonb,  -- the source ids
  position           integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (course_id, concept_id)
);
CREATE INDEX IF NOT EXISTS course_concepts_concept_idx ON course_concepts (concept_id);

-- What the comparison with similar roles' courses found.
CREATE TABLE IF NOT EXISTS course_reuse (
  course_id      uuid NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  from_course_id uuid REFERENCES courses (id) ON DELETE SET NULL,
  concept_id     uuid NOT NULL REFERENCES role_concepts (id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('covered', 'related', 'new')),
  PRIMARY KEY (course_id, concept_id)
);

-- Sections and chapters keep their identity across versions, so a reader's progress survives every update.
CREATE TABLE IF NOT EXISTS course_sections (
  id        uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid    NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  position  integer NOT NULL CHECK (position >= 0),
  title     text    NOT NULL,
  summary   text    NOT NULL DEFAULT '',
  UNIQUE (course_id, position)
);

CREATE TABLE IF NOT EXISTS course_chapters (
  id               uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id       uuid    NOT NULL REFERENCES course_sections (id) ON DELETE CASCADE,
  position         integer NOT NULL CHECK (position >= 0),
  added_in_version uuid    NOT NULL REFERENCES course_versions (id) ON DELETE CASCADE,
  status           text    NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'under_review', 'removed')),
  UNIQUE (section_id, position)
);

-- A row exists only for a version in which that chapter's text changed; a chapter reads as its latest row at or before the published version.
CREATE TABLE IF NOT EXISTS chapter_texts (
  chapter_id uuid NOT NULL REFERENCES course_chapters (id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES course_versions (id) ON DELETE CASCADE,
  title      text NOT NULL,
  body       text NOT NULL,
  PRIMARY KEY (chapter_id, version_id)
);
CREATE INDEX IF NOT EXISTS chapter_texts_version_idx ON chapter_texts (version_id);

CREATE TABLE IF NOT EXISTS chapter_concepts (
  chapter_id uuid    NOT NULL REFERENCES course_chapters (id) ON DELETE CASCADE,
  concept_id uuid    NOT NULL REFERENCES role_concepts (id) ON DELETE CASCADE,
  position   integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (chapter_id, concept_id),
  UNIQUE (chapter_id, position)
);

CREATE TABLE IF NOT EXISTS section_quizzes (
  section_id  uuid  NOT NULL REFERENCES course_sections (id) ON DELETE CASCADE,
  version_id  uuid  NOT NULL REFERENCES course_versions (id) ON DELETE CASCADE,
  questions   jsonb NOT NULL,
  verified_at timestamptz,
  PRIMARY KEY (section_id, version_id)
);

CREATE TABLE IF NOT EXISTS story_bible (
  course_id  uuid NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES course_versions (id) ON DELETE CASCADE,
  setting    text NOT NULL DEFAULT '',
  character  text NOT NULL DEFAULT '',
  thread     text NOT NULL DEFAULT '',
  voice      text NOT NULL DEFAULT '',
  PRIMARY KEY (course_id, version_id)
);

-- The one place a piece of a source's text is kept: at most 300 characters supporting a claim about law, safety, money or health,
-- so the owner can audit it. It goes with the course.
CREATE TABLE IF NOT EXISTS claim_excerpts (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id  uuid        NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  chapter_id uuid        NOT NULL REFERENCES course_chapters (id) ON DELETE CASCADE,
  version_id uuid        NOT NULL REFERENCES course_versions (id) ON DELETE CASCADE,
  claim      text        NOT NULL,
  category   text        NOT NULL CHECK (category IN ('law', 'safety', 'money', 'health')),
  excerpt    text        NOT NULL CHECK (char_length(excerpt) <= 300),
  url        text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS claim_excerpts_course_idx ON claim_excerpts (course_id);

-- Readers. course_inputs is the enrolment row: an account has a course when it has one. All of these go with the account.
CREATE TABLE IF NOT EXISTS course_inputs (
  account_id     uuid        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  course_id      uuid        NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  typed_text     text        NOT NULL DEFAULT '' CHECK (char_length(typed_text) <= 4200),  -- the role, a link or a pasted description (4,000 characters)
  last_active_at timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, course_id)
);
CREATE INDEX IF NOT EXISTS course_inputs_active_idx ON course_inputs (course_id, last_active_at);

CREATE TABLE IF NOT EXISTS course_progress (
  account_id uuid        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  chapter_id uuid        NOT NULL REFERENCES course_chapters (id) ON DELETE CASCADE,
  read_at    timestamptz NOT NULL,
  PRIMARY KEY (account_id, chapter_id)
);

CREATE TABLE IF NOT EXISTS section_quiz_results (
  account_id    uuid        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  section_id    uuid        NOT NULL REFERENCES course_sections (id) ON DELETE CASCADE,
  best_score    integer     NOT NULL CHECK (best_score >= 0),
  attempts      integer     NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  last_taken_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, section_id)
);

CREATE TABLE IF NOT EXISTS course_seen (
  account_id   uuid    NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  course_id    uuid    NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  seen_version integer NOT NULL CHECK (seen_version >= 0),
  PRIMARY KEY (account_id, course_id)
);

-- What the limits count: source searches (including cancelled and expired ones), approvals and refresh requests. Purged after 90 days.
CREATE TABLE IF NOT EXISTS course_requests (
  id         bigserial   PRIMARY KEY,
  account_id uuid        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  role_id    uuid        NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  course_id  uuid        REFERENCES courses (id) ON DELETE SET NULL,
  kind       text        NOT NULL CHECK (kind IN ('source_search', 'approval', 'refresh')),
  outcome    text        NOT NULL CHECK (outcome IN ('started', 'served_existing', 'cancelled', 'expired', 'approved', 'refused')),
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS course_requests_account_idx ON course_requests (account_id, kind, created_at);

-- Flags. The reporter is unlinked, not deleted, with the account; the frozen text stays. One flag per reader, target and (UTC) day.
CREATE TABLE IF NOT EXISTS course_flags (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid        REFERENCES accounts (id) ON DELETE SET NULL,
  course_id   uuid        NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  version_id  uuid        NOT NULL REFERENCES course_versions (id) ON DELETE CASCADE,
  target_type text        NOT NULL CHECK (target_type IN ('chapter', 'concept', 'question')),
  target_id   text        NOT NULL,
  reason      text        NOT NULL CHECK (reason IN ('inaccurate', 'outdated', 'off_topic', 'inappropriate')),
  note        text        NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  snapshot    text        NOT NULL,  -- the text flagged, as it was
  status      text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'handled')),
  action      text        CHECK (action IN ('dismissed', 'edited', 'regenerated', 'withdrawn')),
  created_at  timestamptz NOT NULL,
  handled_at  timestamptz,
  CHECK ((status = 'open' AND action IS NULL AND handled_at IS NULL) OR (status = 'handled' AND action IS NOT NULL AND handled_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS course_flags_daily_key ON course_flags (reporter_id, target_type, target_id, ((created_at AT TIME ZONE 'UTC')::date));
CREATE INDEX IF NOT EXISTS course_flags_target_idx ON course_flags (course_id, target_type, target_id);

-- The changelog. A change belongs to the version that made it and is shown once that version is published.
CREATE TABLE IF NOT EXISTS course_changes (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id    uuid        NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  version_id   uuid        NOT NULL REFERENCES course_versions (id) ON DELETE CASCADE,
  kind         text        NOT NULL CHECK (kind IN ('concept_added', 'term_updated', 'criticality_changed', 'chapter_added', 'chapter_corrected', 'resource_replaced', 'postings_updated')),
  target       text,
  summary      text        NOT NULL,  -- plain words; includes the old value where there was one
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS course_changes_course_idx ON course_changes (course_id, created_at);

-- Switches, caps and limits, so they change without a deploy. A missing 'courses_off' row means courses are off.
CREATE TABLE IF NOT EXISTS course_settings (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
