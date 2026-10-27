-- Migration 022: Sign in with Apple. Makes google_sub optional, adds apple_sub (unique) and requires at least one of the two. Additive: no row changes, and it can be run twice.
BEGIN;

-- Sign in with Apple: an account is keyed by a Google sub or by an Apple sub (Apple's stable id for the reader and this app). The two kinds of account stay separate: nothing merges them, not even
-- the same email. An account has at least one of the two ids; every account made before this has a Google one, so nothing existing changes.
ALTER TABLE accounts ALTER COLUMN google_sub DROP NOT NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS apple_sub text UNIQUE;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_has_sub;
ALTER TABLE accounts ADD CONSTRAINT accounts_has_sub CHECK (google_sub IS NOT NULL OR apple_sub IS NOT NULL);

COMMIT;
