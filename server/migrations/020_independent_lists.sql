BEGIN;

-- Plan 16, part 12: a reader's lists are independent. A list built from a pasted posting for a business analyst role is its own list: it is flagged independent, so the
-- one-private-course-per-reader-role-industry rule does not apply to it, and it owns its private concepts (a course for each), so building or deleting one list never
-- touches another. Each reader's entry for a list can carry a title of their own. Nothing is deleted or changed in rows that exist: older courses keep the old rules.
ALTER TABLE courses ADD COLUMN IF NOT EXISTS independent boolean NOT NULL DEFAULT false;
ALTER TABLE role_concepts ADD COLUMN IF NOT EXISTS course_id uuid REFERENCES courses (id) ON DELETE CASCADE;
ALTER TABLE course_inputs ADD COLUMN IF NOT EXISTS title text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 80);
DROP INDEX IF EXISTS courses_private_role_industry_key;
CREATE UNIQUE INDEX IF NOT EXISTS courses_private_role_industry_key ON courses (owner_account_id, role_id, industry, mode) WHERE visibility = 'private' AND NOT independent AND status IN ('building', 'ready', 'withdrawn');
DROP INDEX IF EXISTS role_concepts_private_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS role_concepts_private_name_key ON role_concepts (owner_account_id, role_id, lower(name)) WHERE visibility = 'private' AND course_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS role_concepts_private_course_name_key ON role_concepts (course_id, lower(name)) WHERE visibility = 'private' AND course_id IS NOT NULL;

COMMIT;
