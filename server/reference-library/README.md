# Reference library

Trusted sources per role, kept apart from the posting research the course pipeline runs. **The course pipeline reads it only when library-first research is switched on** (`BuildDeps.library`, off by default; `P4_LIBRARY=1` in `research/p4Run.ts`): a concept the role's library covers is grounded from the sources' text, read for the length of one build and never stored, and the short verified facts keep the source they came from. With the switch off, nothing reads this folder. Design and rationale: `sdlc/reference-library-proposal.md`.

Built so far: `business-analyst/` (the structure being proved), `product-manager/` and `forward-deployed-engineer/`. `data-analyst/` comes after review.

## Layout

```
reference-library/
  README.md            this file
  CHANGELOG.md         one entry per monthly cycle
  shared.json          sources used by more than one role, listed once
  business-analyst/sources.json
  product-manager/sources.json
  forward-deployed-engineer/sources.json
```

A role's `sources.json` holds the sources only that role uses (`sources`), the ids of shared sources it relies on (`uses_shared`), and what was checked and left out (`checked_and_excluded`, with the reason).

## The rule

A source is listed only if it is free and its text can be read and quoted without paying or joining anything. Two access classes are listed:

| `access` | Meaning | Shown to readers as | `pipeline_readable` |
|---|---|---|---|
| `open` | opens in a plain unauthenticated fetch: no login, sign-up or form | nothing | true |
| `free_account` | free, but lessons or downloads need a free account or an email form | "Needs a free account" | false: cited, never fetched |

Paid, member-only and preview-only sources are never listed. A source that fails the check is recorded under `checked_and_excluded`, not dropped silently.

## Entry fields

`id`, `name`, `url`, `layer` (`institutional`, `practical`, `ai-native`), `tier` (1 institution or standards body, 2 company, 3 individual practitioner or academic), `access`, `perspective` (`canonical` = what an institution says the discipline is; `field` = how practitioners do it, expected to diverge), `pipeline_readable`, `applies_to` (role slugs), `rationale`, `licence`, `free_parts`, `last_verified`, `next_check`, `status`.

`last_verified` records the date, how it was checked, the HTTP status, content type and size, and `text_verified`: whether the actual text was read. `text_verified: false` means the file opened with no login but its text could not be machine-read here (PDF text layers with embedded fonts; no PDF reader is installed), so quotability of the text is unconfirmed. Licences marked "from knowledge" were not re-checked on the page.

## How a source is checked

Fetch the URL with no credentials and no cookies. Record status, final URL after redirects, content type and size. Reject on a login redirect, 401/403, or a login or membership wall in the article body (navigation text such as "Become a member" is not a wall). Read the page text for HTML; for PDFs, confirm a real PDF opens and extract text where possible. Sources that block the check tool (403) are not listed until opened by hand.

## Monthly cycle

Hand-run, with the owner's review: research new and changed sources, re-open every URL, finalise a diff, update the files and add a `CHANGELOG.md` entry. The AI-native layer also gets a mid-month spot check. Details in the proposal.
