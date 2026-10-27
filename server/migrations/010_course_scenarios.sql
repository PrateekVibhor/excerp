-- Migration 010 (Plan 16, part 2): scenario concepts. Adds one column; nothing existing is changed or removed.
BEGIN;

-- Plan 16, part 2: a concept is a skill or a scenario (a recurring workplace situation the postings describe); both are merged, counted and taught alike.
ALTER TABLE role_concepts ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'skill' CHECK (kind IN ('skill', 'scenario'));

COMMIT;
