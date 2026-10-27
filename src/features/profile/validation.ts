import { INDUSTRIES, INTERESTS, type Profile } from '../../data/types';

export const NAME_MAX = 40;
export const INTERESTS_MAX = 8;
export const CUSTOM_TOPIC_MAX = 30;
/** The chip that lets the reader type their own topic. It is never saved itself; the typed text is. */
export const OTHER_TOPIC = 'Other';

export interface ProfileDraft {
  display_name: string;
  industry: string;
  interests: string[];
}

export interface ProfileErrors {
  display_name?: string;
  industry?: string;
  interests?: string;
}

export type ProfileCheck = { ok: true; profile: Profile } | { ok: false; errors: ProfileErrors };

const isIn = <T extends string>(list: readonly T[], value: string): value is T =>
  (list as readonly string[]).includes(value);

/**
 * The form a topic is saved in. Spaces are tidied. A topic that matches a preset ignoring case takes the
 * preset's own spelling ("generative ai" -> "Generative AI"). Anything else gets a capital first letter
 * and lower-case for the rest ("FINANCE" and "finance" both become "Finance"), so the same topic typed
 * different ways is stored one way. Plain upper/lower-casing, not the device's language rules, so every
 * phone saves the same text.
 */
export function normalizeTopic(text: string): string {
  const tidy = text.trim().replace(/\s+/g, ' ');
  if (tidy === '') return '';
  const preset = INTERESTS.find((p) => p.toLowerCase() === tidy.toLowerCase());
  if (preset) return preset;
  const [first, ...rest] = Array.from(tidy);
  return first.toUpperCase() + rest.join('').toLowerCase();
}

/** Checks the topics of a draft; each entry is a preset or whatever the reader typed under "Other". */
function checkInterests(raw: string[]): { topics: string[]; error?: string } {
  if (raw.length === 0) return { topics: [], error: 'Pick at least one topic.' };
  if (raw.length > INTERESTS_MAX) return { topics: [], error: `Pick at most ${INTERESTS_MAX} topics.` };
  const topics = raw.map(normalizeTopic);
  if (topics.some((t) => t === '')) return { topics, error: 'Type your topic.' };
  if (topics.some((t) => t === OTHER_TOPIC)) return { topics, error: 'Type a specific topic instead of "Other".' };
  if (topics.some((t) => !isIn(INTERESTS, t) && Array.from(t).length > CUSTOM_TOPIC_MAX))
    return { topics, error: `Use ${CUSTOM_TOPIC_MAX} characters or fewer.` };
  if (new Set(topics).size !== topics.length) return { topics, error: 'That topic is already selected.' };
  return { topics };
}

/** Checks a draft against the spec's rules. The saved name is trimmed and the topics are normalized. */
export function validateProfile(draft: ProfileDraft): ProfileCheck {
  const errors: ProfileErrors = {};
  const name = draft.display_name.trim();
  // Array.from counts what a person sees as characters, so an emoji is one.
  const length = Array.from(name).length;
  if (length === 0) errors.display_name = 'Enter a name.';
  else if (length > NAME_MAX) errors.display_name = `Use ${NAME_MAX} characters or fewer.`;

  if (!isIn(INDUSTRIES, draft.industry)) errors.industry = 'Pick an industry.';

  const interests = checkInterests(draft.interests);
  if (interests.error) errors.interests = interests.error;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    profile: {
      display_name: name,
      industry: draft.industry as Profile['industry'],
      interests: interests.topics,
    },
  };
}

/**
 * Adds or removes one chip ("Other" included, since it holds a topic's place). Adding past the limit is
 * refused: the list comes back unchanged with `refused: true`, so the screen can say why.
 */
export function toggleInterest(
  selected: readonly string[],
  interest: string,
): { interests: string[]; refused: boolean } {
  if (selected.includes(interest)) return { interests: selected.filter((i) => i !== interest), refused: false };
  if (selected.length >= INTERESTS_MAX) return { interests: [...selected], refused: true };
  return { interests: [...selected, interest], refused: false };
}
