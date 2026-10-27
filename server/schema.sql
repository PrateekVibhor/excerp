-- One table, matching the Article type in src/data/types.ts of the app.
-- A database that already exists is brought up to date with the files in migrations/.
-- The checks repeat the pipeline's own validation, so bad data cannot be stored
-- even if a code path forgets to validate.
CREATE TABLE IF NOT EXISTS articles (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_company text        NOT NULL CHECK (source_company IN ('NVIDIA', 'Google', 'Meta', 'OpenAI', 'Anthropic', 'AWS', 'Microsoft', 'McKinsey', 'BCG', 'Bain & Company', 'CFA Institute', 'Harvard Business Review', 'MIT Sloan Management Review', 'BlackRock', 'World Economic Forum', 'Y Combinator', 'Sequoia Capital', 'Andreessen Horowitz', 'General Catalyst')),
  source_url     text        NOT NULL UNIQUE,  -- one record per URL: the pipeline never stores an article twice
  content_type   text        NOT NULL CHECK (content_type IN ('Research Paper', 'White Paper', 'Tech Blog', 'Release', 'Consulting', 'Finance', 'Venture Capital')),
  title          text        NOT NULL CHECK (length(trim(title)) > 0),
  summary        text        NOT NULL CHECK (array_length(regexp_split_to_array(trim(summary), '\s+'), 1) BETWEEN 50 AND 60),
  published_at   timestamptz NOT NULL,
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  reader_count   integer     NOT NULL DEFAULT 0 CHECK (reader_count >= 0),
  quiz           jsonb,  -- Feature 8: { questions: [...] }, or null when none was generated
  topic          text    -- Feature 8: one of the interest topics, or null
);

-- GET /feed reads newest first.
CREATE INDEX IF NOT EXISTS articles_published_at_idx ON articles (published_at DESC);

-- Feature 9: the leaderboard. No accounts: a player is a random device id the app makes on first use.
-- The pipeline never deletes articles, so a verification keeps pointing at a real one.
CREATE TABLE IF NOT EXISTS players (
  device_id    text        PRIMARY KEY CHECK (device_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),  -- a UUID, lower case
  display_name text        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 40 AND display_name = btrim(display_name)),
  updated_at   timestamptz NOT NULL
);

-- One row per device and article, so a verification sent twice counts once. A player's count is their rows.
CREATE TABLE IF NOT EXISTS verifications (
  device_id   text        NOT NULL REFERENCES players (device_id),
  article_id  uuid        NOT NULL REFERENCES articles (id),
  verified_at timestamptz NOT NULL,
  PRIMARY KEY (device_id, article_id)
);

-- Feature 11: Google Sign-In with an allow-list.
-- The people who may use the app. The owner edits this with `npm run allow`. Emails are kept lower case.
CREATE TABLE IF NOT EXISTS allowed_emails (
  email    text        PRIMARY KEY CHECK (email = lower(email) AND char_length(email) <= 254),
  added_at timestamptz NOT NULL DEFAULT now()
);

-- Readers who signed in with Google and were not on the list: the email and when, nothing else.
CREATE TABLE IF NOT EXISTS access_requests (
  email              text        PRIMARY KEY CHECK (email = lower(email) AND char_length(email) <= 254),
  first_requested_at timestamptz NOT NULL,
  last_requested_at  timestamptz NOT NULL
);

-- A signed-in, approved reader. Only the hash of the token is stored, never the token.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text        PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),  -- SHA-256, lower-case hex
  email      text        NOT NULL CHECK (email = lower(email)),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);

-- Pipeline catch-up: one row per run of the pipeline.
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id          bigserial   PRIMARY KEY,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  outcome     text        NOT NULL CHECK (outcome IN ('ok', 'failed')),
  stored      integer     CHECK (stored >= 0),  -- articles stored by a run that went through; null for a failure
  error       text,                             -- why a run failed
  CHECK (finished_at >= started_at)
);
CREATE INDEX IF NOT EXISTS pipeline_runs_ok_idx ON pipeline_runs (started_at DESC) WHERE outcome = 'ok';

-- Plan 14: accounts. One per approved Google account, keyed by Google's stable `sub` (the email is only an attribute).
CREATE TABLE IF NOT EXISTS accounts (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub         text        NOT NULL UNIQUE,
  ref                text        NOT NULL UNIQUE CHECK (ref ~ '^EXC-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$'),  -- the short code shown in the app, derived from the sub
  email              text        NOT NULL CHECK (email = lower(email) AND char_length(email) <= 254),
  display_name       text        CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 40),
  claimed_name       text        CHECK (claimed_name IS NULL OR char_length(claimed_name) BETWEEN 1 AND 40),  -- the name an old device used, until a profile gives one
  industry           text,
  interests          jsonb,
  profile_updated_at timestamptz,
  profile_rev        bigint      NOT NULL DEFAULT 0,
  rev                bigint      NOT NULL DEFAULT 0,  -- counts the account's changes; a phone's sync cursor is a value of it
  sync_started_at    timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- A session belongs to an account. Sessions made before this have none.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES accounts (id) ON DELETE CASCADE;

-- Saved articles. A removed one stays as a marker so the other phones remove it too.
CREATE TABLE IF NOT EXISTS account_reading_list (
  account_id uuid        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  article_id uuid        NOT NULL REFERENCES articles (id),
  saved_at   timestamptz NOT NULL,
  removed    boolean     NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL,
  rev        bigint      NOT NULL,
  PRIMARY KEY (account_id, article_id)
);

-- Verified articles. Only ever added.
CREATE TABLE IF NOT EXISTS account_verifications (
  account_id  uuid        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  article_id  uuid        NOT NULL REFERENCES articles (id),
  verified_at timestamptz NOT NULL,
  topic       text        NOT NULL CHECK (char_length(topic) BETWEEN 1 AND 40),
  rev         bigint      NOT NULL,
  PRIMARY KEY (account_id, article_id)
);

-- How many times the account skipped an article: a counter, with no time, device or session.
CREATE TABLE IF NOT EXISTS account_skips (
  account_id uuid    NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  article_id uuid    NOT NULL REFERENCES articles (id),
  skips      integer NOT NULL CHECK (skips > 0),
  PRIMARY KEY (account_id, article_id)
);

-- An old random device id claimed by an account. The first claim wins.
CREATE TABLE IF NOT EXISTS device_claims (
  device_id  text PRIMARY KEY CHECK (device_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS device_claims_account_idx ON device_claims (account_id);

-- Plan 15: readers who can see each other, blocks and reports. Everything is off or empty to begin with.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS public_id          uuid        NOT NULL DEFAULT gen_random_uuid(),  -- what other readers see instead of any real id
  ADD COLUMN IF NOT EXISTS discoverable       boolean     NOT NULL DEFAULT false,              -- shown to other readers of the same article
  ADD COLUMN IF NOT EXISTS accepts_messages   boolean     NOT NULL DEFAULT false,              -- may be sent a message request (only while discoverable)
  ADD COLUMN IF NOT EXISTS adult_confirmed_at timestamptz,                                      -- the reader said they are 18 or older
  ADD COLUMN IF NOT EXISTS terms_accepted_at  timestamptz,                                      -- ... and accepted the Terms of Use
  ADD COLUMN IF NOT EXISTS suspended_until    timestamptz;                                      -- set by the moderator: hidden, and cannot message
CREATE UNIQUE INDEX IF NOT EXISTS accounts_public_id_key ON accounts (public_id);

-- Who a reader has blocked. Neither side sees the other; the blocked reader is never told.
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id uuid        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  blocked_id uuid        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS blocks_blocked_idx ON blocks (blocked_id);

-- Reports for the moderator. The snapshot is a frozen copy of what was reported, so changing a name or deleting a message does not
-- erase it. The people are unlinked (null) if their account is deleted; the snapshot stays.
CREATE TABLE IF NOT EXISTS reports (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid        REFERENCES accounts (id) ON DELETE SET NULL,
  reported_id uuid        REFERENCES accounts (id) ON DELETE SET NULL,
  message_id  uuid,       -- a reported message (added with messages)
  kind        text        NOT NULL CHECK (kind IN ('profile', 'message')),
  reason      text        NOT NULL CHECK (reason IN ('spam', 'harassment', 'hate', 'sexual', 'scam', 'other')),
  note        text        CHECK (note IS NULL OR char_length(note) <= 500),
  snapshot    jsonb       NOT NULL,
  status      text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at  timestamptz NOT NULL,
  handled_at  timestamptz,
  action      text
);
CREATE INDEX IF NOT EXISTS reports_open_idx ON reports (created_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS reports_pair_idx ON reports (reporter_id, reported_id, created_at);

-- The readers of an article and the real reader counts.
CREATE INDEX IF NOT EXISTS account_reading_list_article_idx ON account_reading_list (article_id) WHERE NOT removed;
CREATE INDEX IF NOT EXISTS account_verifications_article_idx ON account_verifications (article_id);

-- Plan 15, part 2: message requests and conversations, and the moderator's log.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS banned_at timestamptz;  -- set by the moderator: cannot sign in again

-- One ordering for everything a reader's inbox can poll for.
CREATE SEQUENCE IF NOT EXISTS inbox_seq;

-- A request is the first message of a conversation. It opens when the person asked accepts. Both people are set to null if their
-- account is deleted: what was sent stays with the other person, without the name.
CREATE TABLE IF NOT EXISTS conversations (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  initiator_id uuid        REFERENCES accounts (id) ON DELETE SET NULL,
  recipient_id uuid        REFERENCES accounts (id) ON DELETE SET NULL,
  article_id   uuid        REFERENCES articles (id),
  state        text        NOT NULL CHECK (state IN ('request', 'open', 'declined', 'expired')),
  created_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  state_seq    bigint      NOT NULL DEFAULT nextval('inbox_seq')
);
-- Two people have one conversation at a time, whatever happened to it, until its messages are gone.
CREATE UNIQUE INDEX IF NOT EXISTS conversations_pair_key ON conversations (LEAST(initiator_id, recipient_id), GREATEST(initiator_id, recipient_id))
  WHERE initiator_id IS NOT NULL AND recipient_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversations_initiator_idx ON conversations (initiator_id, created_at);
CREATE INDEX IF NOT EXISTS conversations_recipient_idx ON conversations (recipient_id);

CREATE TABLE IF NOT EXISTS messages (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id       uuid        NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  sender_id             uuid        REFERENCES accounts (id) ON DELETE SET NULL,
  recipient_id          uuid        REFERENCES accounts (id) ON DELETE SET NULL,
  subject               text        NOT NULL DEFAULT '' CHECK (char_length(subject) <= 120),
  body                  text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  body_key              text        NOT NULL,  -- the body in lower case with its spaces squeezed, hashed: to stop the same text going to many people
  created_at            timestamptz NOT NULL,
  expires_at            timestamptz NOT NULL,  -- twelve months after it was sent
  read_at               timestamptz,
  hidden_by_sender_at   timestamptz,
  hidden_by_recipient_at timestamptz,
  seq                   bigint      NOT NULL DEFAULT nextval('inbox_seq')
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS messages_sender_idx ON messages (sender_id, created_at);
CREATE INDEX IF NOT EXISTS messages_repeat_idx ON messages (sender_id, body_key, created_at);
CREATE INDEX IF NOT EXISTS messages_recipient_idx ON messages (recipient_id);
CREATE INDEX IF NOT EXISTS messages_expires_idx ON messages (expires_at);

-- What the moderator and the automatic checks have done. It holds only a public id, which is random and means nothing outside the app.
CREATE TABLE IF NOT EXISTS moderation_log (
  id         bigserial   PRIMARY KEY,
  account_id uuid        REFERENCES accounts (id) ON DELETE SET NULL,
  public_id  uuid,
  action     text        NOT NULL,
  reason     text        NOT NULL DEFAULT '',
  actor      text        NOT NULL CHECK (actor IN ('owner', 'system')),
  detail     jsonb,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS moderation_log_created_idx ON moderation_log (created_at DESC);

-- Plan 16: narrative role courses. A role's evidence (postings and the skills they ask for), the courses built from it, their versions,
-- what readers do with them, and the flags, changes and settings around them. 29 tables, all new; nothing existing is changed.
-- Spec 16, section 4. Everything here is off until the courses switch (course_settings 'courses_off') is turned on in code.

-- Roles are normalized (lower case, trimmed). A different name for the same role is an alias, not a second role.
CREATE TABLE IF NOT EXISTS roles (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL UNIQUE CHECK (name = lower(btrim(name)) AND char_length(name) BETWEEN 1 AND 120),
  description text        NOT NULL DEFAULT '',  -- a short model-written definition, used to nominate similar roles
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_aliases (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id      uuid        NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  title_seen   text        NOT NULL CHECK (title_seen = lower(btrim(title_seen)) AND char_length(title_seen) BETWEEN 1 AND 200),
  times_seen   integer     NOT NULL DEFAULT 1 CHECK (times_seen >= 1),
  last_seen_at timestamptz NOT NULL,
  UNIQUE (role_id, title_seen)
);

-- The single list of companies discovery searches, shared by every role. It holds links and counts only, never page text.
CREATE TABLE IF NOT EXISTS tracked_companies (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  employer        text        NOT NULL,
  domain          text        NOT NULL UNIQUE CHECK (domain = lower(domain)),
  careers_url     text,
  status          text        NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'trusted', 'blocked')),
  successes       integer     NOT NULL DEFAULT 0 CHECK (successes >= 0),
  failures        integer     NOT NULL DEFAULT 0 CHECK (failures >= 0),
  last_checked_at timestamptz,
  last_matched_at timestamptz,
  added_by        text        NOT NULL CHECK (added_by IN ('seed', 'search', 'owner')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- A skill of a role: the unit of reuse. Its criticality is the share of the role's current postings that ask for it, or null
-- when the evidence does not support one. A private concept exists only for a course built with a pasted description.
CREATE TABLE IF NOT EXISTS role_concepts (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id           uuid        NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  name              text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  terms             jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- the names the course texts actually use; an older term stays when a newer one replaces it
  plain_explanation text        NOT NULL DEFAULT '',
  mentions          integer     NOT NULL DEFAULT 0 CHECK (mentions >= 0),
  of_postings       integer     NOT NULL DEFAULT 0 CHECK (of_postings >= 0),
  criticality       text        CHECK (criticality IN ('high', 'medium', 'low')),
  derived_from      uuid        REFERENCES role_concepts (id) ON DELETE SET NULL,  -- a concept of a similar role it was reused from
  visibility        text        NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared', 'private')),
  owner_account_id  uuid        REFERENCES accounts (id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((visibility = 'private') = (owner_account_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS role_concepts_shared_name_key ON role_concepts (role_id, lower(name)) WHERE visibility = 'shared';
CREATE UNIQUE INDEX IF NOT EXISTS role_concepts_private_name_key ON role_concepts (owner_account_id, role_id, lower(name)) WHERE visibility = 'private';

-- A posting (or a pasted description) as evidence. The page text is not stored: a pasted description lives only in course_inputs.
CREATE TABLE IF NOT EXISTS sources (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id               uuid        NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  role_title            text        NOT NULL CHECK (char_length(role_title) BETWEEN 1 AND 300),  -- the exact title used at that company
  designation           text,
  company               text        NOT NULL,
  url                   text,                              -- the original posting or application page; null only for a paste
  origin                text        NOT NULL CHECK (origin IN ('user_paste', 'user_url', 'research')),
  found_via             text        NOT NULL CHECK (found_via IN ('tracked_search', 'open_search', 'user')),
  match                 text        NOT NULL CHECK (match IN ('exact', 'alias', 'similar')),
  counts_for_criticality boolean    NOT NULL DEFAULT false,
  visibility            text        NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared', 'private')),
  owner_account_id      uuid        REFERENCES accounts (id) ON DELETE CASCADE,
  posted_at             timestamptz,
  status                text        NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'current', 'closed', 'dropped')),
  last_seen_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (url IS NOT NULL OR origin = 'user_paste'),
  CHECK ((visibility = 'private') = (origin = 'user_paste')),                       -- only a paste is private
  CHECK ((visibility = 'private') = (owner_account_id IS NOT NULL)),
  CHECK (NOT counts_for_criticality OR origin IN ('research', 'user_url'))           -- a paste never counts
);
CREATE UNIQUE INDEX IF NOT EXISTS sources_shared_url_key ON sources (role_id, url) WHERE visibility = 'shared' AND url IS NOT NULL;
CREATE INDEX IF NOT EXISTS sources_role_status_idx ON sources (role_id, status);

-- The skills a source asks for, one row each, so mentions are counted from data.
CREATE TABLE IF NOT EXISTS source_skills (
  source_id  uuid NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  concept_id uuid NOT NULL REFERENCES role_concepts (id) ON DELETE CASCADE,
  PRIMARY KEY (source_id, concept_id)
);
CREATE INDEX IF NOT EXISTS source_skills_concept_idx ON source_skills (concept_id);

-- Claims already checked, so reuse does not check them again. Claims in the four sensitive categories are always re-checked.
CREATE TABLE IF NOT EXISTS concept_claims (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id uuid        NOT NULL REFERENCES role_concepts (id) ON DELETE CASCADE,
  claim      text        NOT NULL,
  category   text        CHECK (category IN ('law', 'safety', 'money', 'health')),
  status     text        NOT NULL DEFAULT 'verified' CHECK (status IN ('verified')),
  source_url text,
  verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS concept_claims_concept_idx ON concept_claims (concept_id);

CREATE TABLE IF NOT EXISTS resources (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id uuid        NOT NULL REFERENCES role_concepts (id) ON DELETE CASCADE,
  kind       text        NOT NULL CHECK (kind IN ('article', 'blog', 'video')),
  title      text        NOT NULL,
  source     text        NOT NULL DEFAULT '',
  url        text        NOT NULL,
  why        text        NOT NULL DEFAULT '',
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS resources_concept_idx ON resources (concept_id);

-- A course is built in versions: a new version is made beside the live one and replaces it in one transaction. The link from a
-- version back to its course is added after courses exists (the two refer to each other).
CREATE TABLE IF NOT EXISTS course_versions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id    uuid        NOT NULL,
  version      integer     NOT NULL CHECK (version >= 1),
  status       text        NOT NULL CHECK (status IN ('building', 'published', 'superseded', 'failed')),
  run_id       bigint,     -- the run that built it
  model        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (course_id, version),
  UNIQUE (course_id, id),
  CHECK (status <> 'published' OR published_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS course_versions_one_published_key ON course_versions (course_id) WHERE status = 'published';
CREATE UNIQUE INDEX IF NOT EXISTS course_versions_one_building_key ON course_versions (course_id) WHERE status = 'building';  -- one build at a time

-- A course is for a role. Several attempts may be pending (finding sources, or awaiting approval) but only one shared course per role
-- is built, ready or withdrawn at a time. A private course exists only for a pasted description. Status is the publish state; the
-- stages of a build are in course_runs.
CREATE TABLE IF NOT EXISTS courses (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id          uuid        NOT NULL REFERENCES roles (id),
  title            text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  visibility       text        NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared', 'private')),
  owner_account_id uuid        REFERENCES accounts (id) ON DELETE CASCADE,  -- a private course goes with its owner
  requested_by     uuid        REFERENCES accounts (id) ON DELETE SET NULL, -- who started it; a pending course is visible to this account only
  status           text        NOT NULL DEFAULT 'finding_sources' CHECK (status IN ('finding_sources', 'awaiting_approval', 'building', 'ready', 'failed', 'cancelled', 'withdrawn')),
  failure_reason   text,
  withdrawn_at     timestamptz,
  withdrawal_note  text,       -- shown to readers
  pool_size        integer     NOT NULL DEFAULT 0 CHECK (pool_size >= 0),  -- postings in the evidence when last built
  evidence_thin    boolean     NOT NULL DEFAULT false,                     -- fewer than eight postings remain
  replace_count    integer     NOT NULL DEFAULT 0 CHECK (replace_count BETWEEN 0 AND 2),
  approved_at      timestamptz,
  generated_at     timestamptz,
  last_checked_at  timestamptz,
  next_check_at    timestamptz,
  model            text,
  published_version uuid,      -- the live version, set only in the transaction that publishes it
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((visibility = 'private') = (owner_account_id IS NOT NULL)),
  CHECK (status <> 'withdrawn' OR withdrawn_at IS NOT NULL),
  CHECK (status <> 'ready' OR published_version IS NOT NULL),
  CONSTRAINT courses_published_version_fk FOREIGN KEY (id, published_version) REFERENCES course_versions (course_id, id)  -- the version must be this course's own
);
CREATE UNIQUE INDEX IF NOT EXISTS courses_shared_role_key ON courses (role_id) WHERE visibility = 'shared' AND status IN ('building', 'ready', 'withdrawn');
CREATE UNIQUE INDEX IF NOT EXISTS courses_private_role_key ON courses (owner_account_id, role_id) WHERE visibility = 'private' AND status IN ('building', 'ready', 'withdrawn');
CREATE INDEX IF NOT EXISTS courses_next_check_idx ON courses (next_check_at) WHERE status = 'ready';
CREATE INDEX IF NOT EXISTS courses_role_idx ON courses (role_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'course_versions_course_fk' AND conrelid = 'course_versions'::regclass) THEN
    ALTER TABLE course_versions ADD CONSTRAINT course_versions_course_fk FOREIGN KEY (course_id) REFERENCES courses (id) ON DELETE CASCADE;
  END IF;
END $$;

-- Cost and progress of each run (source finding, a generation, a refresh, a correction).
CREATE TABLE IF NOT EXISTS course_runs (
  id             bigserial   PRIMARY KEY,
  course_id      uuid        NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  version_id     uuid        REFERENCES course_versions (id) ON DELETE CASCADE,  -- null for source finding
  kind           text        NOT NULL CHECK (kind IN ('source_finding', 'generation', 'refresh', 'correction')),
  requested_by   uuid        REFERENCES accounts (id) ON DELETE SET NULL,
  stage          text        NOT NULL DEFAULT '',
  percent        integer     NOT NULL DEFAULT 0 CHECK (percent BETWEEN 0 AND 100),
  tavily_credits integer     NOT NULL DEFAULT 0 CHECK (tavily_credits >= 0),
  tokens_in      bigint      NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out     bigint      NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  started_at     timestamptz NOT NULL,
  finished_at    timestamptz,
  error          text,
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);
CREATE INDEX IF NOT EXISTS course_runs_course_idx ON course_runs (course_id, started_at DESC);

-- What the reader is shown and approves, and what the course teaches and why.
CREATE TABLE IF NOT EXISTS course_sources (
  course_id uuid NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  use       text NOT NULL CHECK (use IN ('pool', 'reader', 'not_used')),
  reason    text,
  state     text NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed', 'approved', 'replaced')),
  PRIMARY KEY (course_id, source_id),
  CHECK (use <> 'not_used' OR (reason IS NOT NULL AND reason <> ''))
);
CREATE INDEX IF NOT EXISTS course_sources_source_idx ON course_sources (source_id);

CREATE TABLE IF NOT EXISTS course_concepts (
  course_id          uuid    NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  concept_id         uuid    NOT NULL REFERENCES role_concepts (id) ON DELETE CASCADE,
  from_reader_source boolean NOT NULL DEFAULT false,  -- a concept only the reader's own link or paste asks for
  asked_by           jsonb   NOT NULL DEFAULT '[]'::jsonb,  -- the source ids
  position           integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (course_id, concept_id)
);
CREATE INDEX IF NOT EXISTS course_concepts_concept_idx ON course_concepts (concept_id);

-- What the comparison with similar roles' courses found.
CREATE TABLE IF NOT EXISTS course_reuse (
  course_id      uuid NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  from_course_id uuid REFERENCES courses (id) ON DELETE SET NULL,
  concept_id     uuid NOT NULL REFERENCES role_concepts (id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('covered', 'related', 'new')),
  PRIMARY KEY (course_id, concept_id)
);

-- Sections and chapters keep their identity across versions, so a reader's progress survives every update.
CREATE TABLE IF NOT EXISTS course_sections (
  id        uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid    NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  position  integer NOT NULL CHECK (position >= 0),
  title     text    NOT NULL,
  summary   text    NOT NULL DEFAULT '',
  UNIQUE (course_id, position)
);

CREATE TABLE IF NOT EXISTS course_chapters (
  id               uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id       uuid    NOT NULL REFERENCES course_sections (id) ON DELETE CASCADE,
  position         integer NOT NULL CHECK (position >= 0),
  added_in_version uuid    NOT NULL REFERENCES course_versions (id) ON DELETE CASCADE,
  status           text    NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'under_review', 'removed')),
  UNIQUE (section_id, position)
);

-- A row exists only for a version in which that chapter's text changed; a chapter reads as its latest row at or before the published version.
CREATE TABLE IF NOT EXISTS chapter_texts (
  chapter_id uuid NOT NULL REFERENCES course_chapters (id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES course_versions (id) ON DELETE CASCADE,
  title      text NOT NULL,
  body       text NOT NULL,
  PRIMARY KEY (chapter_id, version_id)
);
CREATE INDEX IF NOT EXISTS chapter_texts_version_idx ON chapter_texts (version_id);

CREATE TABLE IF NOT EXISTS chapter_concepts (
  chapter_id uuid    NOT NULL REFERENCES course_chapters (id) ON DELETE CASCADE,
  concept_id uuid    NOT NULL REFERENCES role_concepts (id) ON DELETE CASCADE,
  position   integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (chapter_id, concept_id),
  UNIQUE (chapter_id, position)
);

CREATE TABLE IF NOT EXISTS section_quizzes (
  section_id  uuid  NOT NULL REFERENCES course_sections (id) ON DELETE CASCADE,
  version_id  uuid  NOT NULL REFERENCES course_versions (id) ON DELETE CASCADE,
  questions   jsonb NOT NULL,
  verified_at timestamptz,
  PRIMARY KEY (section_id, version_id)
);

CREATE TABLE IF NOT EXISTS story_bible (
  course_id  uuid NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES course_versions (id) ON DELETE CASCADE,
  setting    text NOT NULL DEFAULT '',
  character  text NOT NULL DEFAULT '',
  thread     text NOT NULL DEFAULT '',
  voice      text NOT NULL DEFAULT '',
  PRIMARY KEY (course_id, version_id)
);

-- The one place a piece of a source's text is kept: at most 300 characters supporting a claim about law, safety, money or health,
-- so the owner can audit it. It goes with the course.
CREATE TABLE IF NOT EXISTS claim_excerpts (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id  uuid        NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  chapter_id uuid        NOT NULL REFERENCES course_chapters (id) ON DELETE CASCADE,
  version_id uuid        NOT NULL REFERENCES course_versions (id) ON DELETE CASCADE,
  claim      text        NOT NULL,
  category   text        NOT NULL CHECK (category IN ('law', 'safety', 'money', 'health')),
  excerpt    text        NOT NULL CHECK (char_length(excerpt) <= 300),
  url        text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS claim_excerpts_course_idx ON claim_excerpts (course_id);

-- Readers. course_inputs is the enrolment row: an account has a course when it has one. All of these go with the account.
CREATE TABLE IF NOT EXISTS course_inputs (
  account_id     uuid        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  course_id      uuid        NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  typed_text     text        NOT NULL DEFAULT '' CHECK (char_length(typed_text) <= 4200),  -- the role, a link or a pasted description (4,000 characters)
  last_active_at timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, course_id)
);
CREATE INDEX IF NOT EXISTS course_inputs_active_idx ON course_inputs (course_id, last_active_at);

CREATE TABLE IF NOT EXISTS course_progress (
  account_id uuid        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  chapter_id uuid        NOT NULL REFERENCES course_chapters (id) ON DELETE CASCADE,
  read_at    timestamptz NOT NULL,
  PRIMARY KEY (account_id, chapter_id)
);

CREATE TABLE IF NOT EXISTS section_quiz_results (
  account_id    uuid        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  section_id    uuid        NOT NULL REFERENCES course_sections (id) ON DELETE CASCADE,
  best_score    integer     NOT NULL CHECK (best_score >= 0),
  attempts      integer     NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  last_taken_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, section_id)
);

CREATE TABLE IF NOT EXISTS course_seen (
  account_id   uuid    NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  course_id    uuid    NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  seen_version integer NOT NULL CHECK (seen_version >= 0),
  PRIMARY KEY (account_id, course_id)
);

-- What the limits count: source searches (including cancelled and expired ones), approvals and refresh requests. Purged after 90 days.
CREATE TABLE IF NOT EXISTS course_requests (
  id         bigserial   PRIMARY KEY,
  account_id uuid        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  role_id    uuid        NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  course_id  uuid        REFERENCES courses (id) ON DELETE SET NULL,
  kind       text        NOT NULL CHECK (kind IN ('source_search', 'approval', 'refresh')),
  outcome    text        NOT NULL CHECK (outcome IN ('started', 'served_existing', 'cancelled', 'expired', 'approved', 'refused')),
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS course_requests_account_idx ON course_requests (account_id, kind, created_at);

-- Flags. The reporter is unlinked, not deleted, with the account; the frozen text stays. One flag per reader, target and (UTC) day.
CREATE TABLE IF NOT EXISTS course_flags (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid        REFERENCES accounts (id) ON DELETE SET NULL,
  course_id   uuid        NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  version_id  uuid        NOT NULL REFERENCES course_versions (id) ON DELETE CASCADE,
  target_type text        NOT NULL CHECK (target_type IN ('chapter', 'concept', 'question')),
  target_id   text        NOT NULL,
  reason      text        NOT NULL CHECK (reason IN ('inaccurate', 'outdated', 'off_topic', 'inappropriate')),
  note        text        NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  snapshot    text        NOT NULL,  -- the text flagged, as it was
  status      text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'handled')),
  action      text        CHECK (action IN ('dismissed', 'edited', 'regenerated', 'withdrawn')),
  created_at  timestamptz NOT NULL,
  handled_at  timestamptz,
  CHECK ((status = 'open' AND action IS NULL AND handled_at IS NULL) OR (status = 'handled' AND action IS NOT NULL AND handled_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS course_flags_daily_key ON course_flags (reporter_id, target_type, target_id, ((created_at AT TIME ZONE 'UTC')::date));
CREATE INDEX IF NOT EXISTS course_flags_target_idx ON course_flags (course_id, target_type, target_id);

-- The changelog. A change belongs to the version that made it and is shown once that version is published.
CREATE TABLE IF NOT EXISTS course_changes (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id    uuid        NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  version_id   uuid        NOT NULL REFERENCES course_versions (id) ON DELETE CASCADE,
  kind         text        NOT NULL CHECK (kind IN ('concept_added', 'term_updated', 'criticality_changed', 'chapter_added', 'chapter_corrected', 'resource_replaced', 'postings_updated')),
  target       text,
  summary      text        NOT NULL,  -- plain words; includes the old value where there was one
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS course_changes_course_idx ON course_changes (course_id, created_at);

-- Switches, caps and limits, so they change without a deploy. A missing 'courses_off' row means courses are off.
CREATE TABLE IF NOT EXISTS course_settings (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Plan 16, part 2: a concept is a skill or a scenario (a recurring workplace situation the postings describe); both are merged, counted and taught alike.
ALTER TABLE role_concepts ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'skill' CHECK (kind IN ('skill', 'scenario'));

-- Plan 16, part 3: a course is for a role and an industry (none chosen is its own, as courses built before industries are). What is researched for a concept is kept per industry.
ALTER TABLE courses ADD COLUMN IF NOT EXISTS industry text NOT NULL DEFAULT '' CHECK (char_length(industry) <= 40);
ALTER TABLE concept_claims ADD COLUMN IF NOT EXISTS industry text NOT NULL DEFAULT '';
ALTER TABLE resources ADD COLUMN IF NOT EXISTS industry text NOT NULL DEFAULT '';
DROP INDEX IF EXISTS courses_shared_role_key;
DROP INDEX IF EXISTS courses_private_role_key;
CREATE UNIQUE INDEX IF NOT EXISTS courses_shared_role_industry_key ON courses (role_id, industry) WHERE visibility = 'shared' AND status IN ('building', 'ready', 'withdrawn');
CREATE UNIQUE INDEX IF NOT EXISTS courses_private_role_industry_key ON courses (owner_account_id, role_id, industry) WHERE visibility = 'private' AND status IN ('building', 'ready', 'withdrawn');

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

-- Plan 16, part 5: the reference library and the skill categories live in the database (the files are an export for backup and audit), and each category's
-- coverage by the library is rated and stored against the library version it was rated at, so improvement over time can be measured.
CREATE TABLE IF NOT EXISTS library_sources (
  id                text        PRIMARY KEY,
  scope             text        NOT NULL,                          -- 'shared', or the role folder the entry came from
  position          integer     NOT NULL DEFAULT 0,                -- order within its file, kept so an export reads like the original
  name              text        NOT NULL,
  url               text        NOT NULL,
  tier              integer     NOT NULL CHECK (tier IN (1, 2, 3)),
  layer             text        NOT NULL,
  access            text        NOT NULL CHECK (access IN ('open', 'free_account')),
  perspective       text        NOT NULL,
  pipeline_readable boolean     NOT NULL,
  applies_to        text[]      NOT NULL DEFAULT '{}',
  status            text        NOT NULL CHECK (status IN ('active', 'candidate_other_roles', 'suspended', 'removed', 'flagged')),
  next_check        date,
  entry             jsonb       NOT NULL,                          -- the whole record exactly as in the files; the columns above are copied from it for queries
  origin            text        NOT NULL DEFAULT 'seed' CHECK (origin IN ('seed', 'finder')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS library_sources_status_idx ON library_sources (status);
CREATE TABLE IF NOT EXISTS library_role_files (
  role_slug            text  PRIMARY KEY,
  role                 text  NOT NULL,
  built                text  NOT NULL DEFAULT '',
  uses_shared          jsonb NOT NULL DEFAULT '[]'::jsonb,
  checked_and_excluded jsonb NOT NULL DEFAULT '[]'::jsonb,
  extra                jsonb NOT NULL DEFAULT '{}'::jsonb             -- any other keys the role's file carries
);
CREATE TABLE IF NOT EXISTS library_meta (
  key   text  PRIMARY KEY,
  value jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS library_changes (                       -- one row per change to the library; the latest version number is the library's version
  version    bigserial   PRIMARY KEY,
  source_id  text,
  kind       text        NOT NULL CHECK (kind IN ('added', 'changed', 'status')),
  summary    text        NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS library_source_index (                  -- which sources have been read to find what they discuss (the text itself is never kept)
  source_id  text        PRIMARY KEY REFERENCES library_sources (id) ON DELETE CASCADE,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  text_chars integer     NOT NULL DEFAULT 0,
  error      text
);
CREATE TABLE IF NOT EXISTS skill_taxonomies (
  role_slug text  PRIMARY KEY,
  role      text  NOT NULL,
  note      text  NOT NULL DEFAULT '',
  tools     jsonb NOT NULL DEFAULT '[]'::jsonb,
  examples  jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE TABLE IF NOT EXISTS skill_categories (
  role_slug   text  NOT NULL,
  id          text  NOT NULL,
  position    integer NOT NULL DEFAULT 0,
  name        text  NOT NULL,
  description text  NOT NULL,
  aliases     jsonb NOT NULL DEFAULT '[]'::jsonb,
  status      text  NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'proposed', 'merged')),
  PRIMARY KEY (role_slug, id)
);
CREATE TABLE IF NOT EXISTS library_source_categories (             -- a source discusses a category this many times (counted when the source was read)
  source_id   text    NOT NULL REFERENCES library_sources (id) ON DELETE CASCADE,
  role_slug   text    NOT NULL,
  category_id text    NOT NULL,
  hits        integer NOT NULL CHECK (hits > 0),
  verdict     text    NOT NULL DEFAULT 'unchecked' CHECK (verdict IN ('unchecked', 'teaches', 'mentions')),  -- whether the source teaches the category or only uses its words; only "teaches" counts toward coverage
  PRIMARY KEY (source_id, role_slug, category_id)
);
CREATE TABLE IF NOT EXISTS category_coverage (
  role_slug       text        NOT NULL,
  category_id     text        NOT NULL,
  library_version bigint      NOT NULL,
  band            text        NOT NULL CHECK (band IN ('strong', 'thin', 'missing')),
  source_ids      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  min_hits        integer     NOT NULL,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_slug, category_id, library_version)
);

-- Plan 16, part 6: the gap queue and the source finder's candidates. A category the library covers thinly or not at all is a gap; the finder looks for sources
-- for it and records what it found and why each page passed or failed. In dry-run nothing found here is added to the library.
CREATE TABLE IF NOT EXISTS library_gaps (
  role_slug          text        NOT NULL,
  category_id        text        NOT NULL,
  status             text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'candidates_ready', 'filled', 'dead_end')),
  demand             integer     NOT NULL DEFAULT 1 CHECK (demand >= 1),
  attempts           integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  credits_spent      integer     NOT NULL DEFAULT 0 CHECK (credits_spent >= 0),
  first_seen_version bigint      NOT NULL,
  filled_version     bigint,
  last_attempt_at    timestamptz,
  note               text        NOT NULL DEFAULT '',
  PRIMARY KEY (role_slug, category_id)
);
CREATE TABLE IF NOT EXISTS library_candidates (
  id          bigserial   PRIMARY KEY,
  role_slug   text        NOT NULL,
  category_id text        NOT NULL,
  url         text        NOT NULL,
  name        text        NOT NULL DEFAULT '',
  status      text        NOT NULL CHECK (status IN ('proposed', 'rejected', 'admitted')),
  reason      text        NOT NULL DEFAULT '',
  tier        integer,
  admitted_version bigint,                                        -- the library version that added it, once it was admitted
  checks      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  draft       jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_slug, category_id, url)
);
CREATE INDEX IF NOT EXISTS library_candidates_status_idx ON library_candidates (role_slug, status);

-- Plan 16, part 7: list mode. A course is either "narrow" (written chapters, as before) or "list" (a sequenced list of concepts, each with real links and a coverage
-- rating, no written text). A role and industry can have one of each. A list course keeps, per published version, its concepts (display name, order, rating)
-- and the links shown for each.
ALTER TABLE courses ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'narrow' CHECK (mode IN ('narrow', 'list'));
DROP INDEX IF EXISTS courses_shared_role_industry_key;
DROP INDEX IF EXISTS courses_private_role_industry_key;
CREATE UNIQUE INDEX IF NOT EXISTS courses_shared_role_industry_key ON courses (role_id, industry, mode) WHERE visibility = 'shared' AND status IN ('building', 'ready', 'withdrawn');
CREATE UNIQUE INDEX IF NOT EXISTS courses_private_role_industry_key ON courses (owner_account_id, role_id, industry, mode) WHERE visibility = 'private' AND status IN ('building', 'ready', 'withdrawn');
CREATE TABLE IF NOT EXISTS list_concepts (
  course_id       uuid        NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  version_id      uuid        NOT NULL REFERENCES course_versions (id) ON DELETE CASCADE,
  concept_id      uuid        NOT NULL REFERENCES role_concepts (id) ON DELETE CASCADE,
  position        integer     NOT NULL CHECK (position >= 0),
  display_name    text        NOT NULL,
  band            text        NOT NULL CHECK (band IN ('strong', 'thin', 'missing')),
  library_links   integer     NOT NULL DEFAULT 0 CHECK (library_links >= 0),
  other_links     integer     NOT NULL DEFAULT 0 CHECK (other_links >= 0),
  library_version bigint,                                          -- the reference library's version when this was rated (none for a library kept in files)
  rated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (version_id, concept_id)
);
CREATE INDEX IF NOT EXISTS list_concepts_course_idx ON list_concepts (course_id, version_id, position);
CREATE TABLE IF NOT EXISTS list_links (
  id                bigserial PRIMARY KEY,
  course_id         uuid      NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  version_id        uuid      NOT NULL REFERENCES course_versions (id) ON DELETE CASCADE,
  concept_id        uuid      NOT NULL REFERENCES role_concepts (id) ON DELETE CASCADE,
  position          integer   NOT NULL CHECK (position >= 0),
  kind              text      NOT NULL CHECK (kind IN ('article', 'blog', 'video')),
  title             text      NOT NULL,
  source            text      NOT NULL DEFAULT '',
  url               text      NOT NULL,
  why               text      NOT NULL DEFAULT '',
  library_source_id text                                           -- set when the link is a vetted library source
);
CREATE INDEX IF NOT EXISTS list_links_concept_idx ON list_links (version_id, concept_id, position);

-- Plan 16, part 8: list-course notifications. A list course tells its readers when a concept's coverage went up, as a change of its own kind in the course's changelog
-- (one per improved concept, in the version that carries it); the unique index stops the same concept being announced twice in one version.
ALTER TABLE course_changes DROP CONSTRAINT IF EXISTS course_changes_kind_check;
ALTER TABLE course_changes ADD CONSTRAINT course_changes_kind_check CHECK (kind IN ('concept_added', 'term_updated', 'criticality_changed', 'chapter_added', 'chapter_corrected', 'resource_replaced', 'postings_updated', 'coverage_improved'));
CREATE UNIQUE INDEX IF NOT EXISTS course_changes_coverage_key ON course_changes (course_id, version_id, kind, target) WHERE kind = 'coverage_improved';

-- Plan 16, part 9: a reader's pasted job description is kept, exactly as pasted, with the reader's own record of the course (course_inputs), so the build can read
-- its skills. It is private to that reader, is never returned by any route, and goes when the reader leaves the course or deletes their account.
ALTER TABLE course_inputs ADD COLUMN IF NOT EXISTS pasted_text text CHECK (pasted_text IS NULL OR char_length(pasted_text) <= 4000);

-- Plan 16, part 10: a concept in a reader's course can stand for several phrasings of one transferable skill. The skill category it was gathered under, and the tools the
-- reader's posting named for it (kept as a note: "you saw Oracle EBS"), are kept with the concept in that course.
ALTER TABLE course_concepts ADD COLUMN IF NOT EXISTS tools jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE course_concepts ADD COLUMN IF NOT EXISTS skill_category text;

-- Plan 16, part 11: a taxonomy can name terms it deliberately leaves unplaced (platform and infrastructure terms, personal traits, one-off phrases), so those stay unplaced
-- every time instead of depending on what the model says on the day.
ALTER TABLE skill_taxonomies ADD COLUMN IF NOT EXISTS unplaced jsonb NOT NULL DEFAULT '[]'::jsonb;

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

-- Plan 16, part 13: a web page judged for a concept of a role (is it a good source for this role?) is remembered for thirty days, so a rebuild, or another
-- reader's list for the same role, does not ask the model about the same page again. The judge column names the model, the stage that asked (research or
-- list) and the prompt version, so a change of any starts afresh. Only a real verdict is kept: a page that could not be judged is not.
CREATE TABLE IF NOT EXISTS link_judgments (
  role_id    uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  concept    text NOT NULL,
  url_key    text NOT NULL,
  domain     text NOT NULL DEFAULT '',
  judge      text NOT NULL,
  keep       boolean NOT NULL,
  kind       text NOT NULL,
  why        text NOT NULL DEFAULT '',
  judged_at  timestamptz NOT NULL,
  PRIMARY KEY (role_id, concept, url_key, domain, judge)
);

-- Sign in with Apple: an account is keyed by a Google sub or by an Apple sub (Apple's stable id for the reader and this app). The two kinds of account stay separate: nothing merges them, not even
-- the same email. An account has at least one of the two ids; every account made before this has a Google one, so nothing existing changes.
ALTER TABLE accounts ALTER COLUMN google_sub DROP NOT NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS apple_sub text UNIQUE;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_has_sub;
ALTER TABLE accounts ADD CONSTRAINT accounts_has_sub CHECK (google_sub IS NOT NULL OR apple_sub IS NOT NULL);
