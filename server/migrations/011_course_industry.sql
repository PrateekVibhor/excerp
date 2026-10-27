-- Migration 011 (Plan 16, part 3): courses split per role and industry. Adds three columns and replaces the two one-course-per-role indexes with ones that include the industry; every existing row keeps industry '' so nothing existing changes.
BEGIN;

-- Plan 16, part 3: a course is for a role and an industry (none chosen is its own, as courses built before industries are). What is researched for a concept is kept per industry.
ALTER TABLE courses ADD COLUMN IF NOT EXISTS industry text NOT NULL DEFAULT '' CHECK (char_length(industry) <= 40);
ALTER TABLE concept_claims ADD COLUMN IF NOT EXISTS industry text NOT NULL DEFAULT '';
ALTER TABLE resources ADD COLUMN IF NOT EXISTS industry text NOT NULL DEFAULT '';
DROP INDEX IF EXISTS courses_shared_role_key;
DROP INDEX IF EXISTS courses_private_role_key;
CREATE UNIQUE INDEX IF NOT EXISTS courses_shared_role_industry_key ON courses (role_id, industry) WHERE visibility = 'shared' AND status IN ('building', 'ready', 'withdrawn');
CREATE UNIQUE INDEX IF NOT EXISTS courses_private_role_industry_key ON courses (owner_account_id, role_id, industry) WHERE visibility = 'private' AND status IN ('building', 'ready', 'withdrawn');

COMMIT;
