-- Migration 012 (Plan 16, part 4): library-first research. Adds one column and one table; nothing existing is changed or removed.
BEGIN;

-- Plan 16, part 4: library-first research. A fact grounded from the reference library keeps the library source it came from, and each concept's research records whether the library or a live search grounded it.
ALTER TABLE concept_claims ADD COLUMN IF NOT EXISTS library_source_id text;
CREATE TABLE IF NOT EXISTS library_use (
  id         bigserial   PRIMARY KEY,
  course_id  uuid        NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  concept_id uuid        NOT NULL REFERENCES role_concepts (id) ON DELETE CASCADE,
  industry   text        NOT NULL DEFAULT '',
  outcome    text        NOT NULL CHECK (outcome IN ('library', 'live')),
  source_ids jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- the library sources whose passages gave the facts
  facts      integer     NOT NULL DEFAULT 0 CHECK (facts >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS library_use_course_idx ON library_use (course_id);

COMMIT;
