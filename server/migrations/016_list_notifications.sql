-- Migration 016 (Plan 16, part 8): list-course notifications. Widens the course_changes kind list by one value and adds a unique index; no data is changed.
BEGIN;

-- Plan 16, part 8: list-course notifications. A list course tells its readers when a concept's coverage went up, as a change of its own kind in the course's changelog
-- (one per improved concept, in the version that carries it); the unique index stops the same concept being announced twice in one version.
ALTER TABLE course_changes DROP CONSTRAINT IF EXISTS course_changes_kind_check;
ALTER TABLE course_changes ADD CONSTRAINT course_changes_kind_check CHECK (kind IN ('concept_added', 'term_updated', 'criticality_changed', 'chapter_added', 'chapter_corrected', 'resource_replaced', 'postings_updated', 'coverage_improved'));
CREATE UNIQUE INDEX IF NOT EXISTS course_changes_coverage_key ON course_changes (course_id, version_id, kind, target) WHERE kind = 'coverage_improved';

COMMIT;
