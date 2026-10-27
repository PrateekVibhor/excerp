BEGIN;

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

COMMIT;
