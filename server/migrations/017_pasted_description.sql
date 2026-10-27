-- Migration 017 (Plan 16, part 9): the pasted job description. Adds one nullable column; nothing existing is changed.
BEGIN;

-- Plan 16, part 9: a reader's pasted job description is kept, exactly as pasted, with the reader's own record of the course (course_inputs), so the build can read
-- its skills. It is private to that reader, is never returned by any route, and goes when the reader leaves the course or deletes their account.
ALTER TABLE course_inputs ADD COLUMN IF NOT EXISTS pasted_text text CHECK (pasted_text IS NULL OR char_length(pasted_text) <= 4000);

COMMIT;
