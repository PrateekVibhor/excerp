-- Migration 019 (Plan 16, part 11): the terms a taxonomy leaves unplaced. Adds one defaulted column to skill_taxonomies; nothing existing is changed.
BEGIN;

-- Plan 16, part 11: a taxonomy can name terms it deliberately leaves unplaced (platform and infrastructure terms, personal traits, one-off phrases), so those stay unplaced
-- every time instead of depending on what the model says on the day.
ALTER TABLE skill_taxonomies ADD COLUMN IF NOT EXISTS unplaced jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMIT;
