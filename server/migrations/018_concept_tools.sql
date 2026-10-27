-- Migration 018 (Plan 16, part 10): the tools a posting named for a concept, and its skill category. Adds two columns to course_concepts; nothing existing is changed.
BEGIN;

-- Plan 16, part 10: a concept in a reader's course can stand for several phrasings of one transferable skill. The skill category it was gathered under, and the tools the
-- reader's posting named for it (kept as a note: "you saw Oracle EBS"), are kept with the concept in that course.
ALTER TABLE course_concepts ADD COLUMN IF NOT EXISTS tools jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE course_concepts ADD COLUMN IF NOT EXISTS skill_category text;

COMMIT;
