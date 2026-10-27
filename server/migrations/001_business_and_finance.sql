-- Business and Finance: twelve new publishers and three new content types.
--
-- Run once on a database created from an older schema.sql:
--   psql "$DATABASE_URL" -f migrations/001_business_and_finance.sql
-- It only widens two rules, so every stored article stays valid, and running it again changes nothing.
-- The lists must match SOURCE_COMPANIES and CONTENT_TYPES in src/data/types.ts (a test checks this).
BEGIN;

ALTER TABLE articles
  DROP CONSTRAINT IF EXISTS articles_source_company_check,
  ADD CONSTRAINT articles_source_company_check CHECK (source_company IN ('NVIDIA', 'Google', 'Meta', 'OpenAI', 'Anthropic', 'AWS', 'Microsoft', 'McKinsey', 'BCG', 'Bain & Company', 'CFA Institute', 'Harvard Business Review', 'MIT Sloan Management Review', 'BlackRock', 'World Economic Forum', 'Y Combinator', 'Sequoia Capital', 'Andreessen Horowitz', 'General Catalyst'));

ALTER TABLE articles
  DROP CONSTRAINT IF EXISTS articles_content_type_check,
  ADD CONSTRAINT articles_content_type_check CHECK (content_type IN ('Research Paper', 'White Paper', 'Tech Blog', 'Release', 'Consulting', 'Finance', 'Venture Capital'));

COMMIT;
