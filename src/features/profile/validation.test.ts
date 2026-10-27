import { INDUSTRIES, INTERESTS } from '../../data/types';
import {
  CUSTOM_TOPIC_MAX,
  INTERESTS_MAX,
  NAME_MAX,
  normalizeTopic,
  OTHER_TOPIC,
  toggleInterest,
  validateProfile,
  type ProfileDraft,
} from './validation';

const draft = (over: Partial<ProfileDraft> = {}): ProfileDraft => ({
  display_name: 'Maya',
  industry: 'Software',
  interests: ['Agents'],
  ...over,
});
const errorsOf = (d: ProfileDraft) => {
  const r = validateProfile(d);
  if (r.ok) throw new Error('expected the draft to be rejected');
  return r.errors;
};

describe('profile validation: name', () => {
  it('accepts 1 and 40 characters', () => {
    expect(validateProfile(draft({ display_name: 'M' })).ok).toBe(true);
    expect(validateProfile(draft({ display_name: 'x'.repeat(NAME_MAX) })).ok).toBe(true);
  });

  it('rejects an empty or blank name', () => {
    expect(errorsOf(draft({ display_name: '' })).display_name).toBeTruthy();
    expect(errorsOf(draft({ display_name: '   ' })).display_name).toBeTruthy();
  });

  it('Scenario: Name length - 41 characters are rejected with a message', () => {
    expect(errorsOf(draft({ display_name: 'x'.repeat(NAME_MAX + 1) })).display_name).toMatch(/40/);
  });

  it('counts the trimmed name, and stores it trimmed', () => {
    const r = validateProfile(draft({ display_name: `  ${'x'.repeat(NAME_MAX)}  ` }));
    expect(r.ok && r.profile.display_name).toBe('x'.repeat(NAME_MAX));
  });

  it('counts an emoji as one character', () => {
    expect(validateProfile(draft({ display_name: '😀'.repeat(NAME_MAX) })).ok).toBe(true);
    expect(validateProfile(draft({ display_name: '😀'.repeat(NAME_MAX + 1) })).ok).toBe(false);
  });
});

describe('profile validation: industry', () => {
  it('accepts every listed industry', () => {
    for (const industry of INDUSTRIES) expect(validateProfile(draft({ industry })).ok).toBe(true);
  });

  it('rejects anything else', () => {
    expect(errorsOf(draft({ industry: 'Aerospace' })).industry).toBeTruthy();
    expect(errorsOf(draft({ industry: '' })).industry).toBeTruthy();
  });
});

describe('profile validation: interests', () => {
  it('needs at least one', () => {
    expect(errorsOf(draft({ interests: [] })).interests).toMatch(/at least one/i);
  });

  it('accepts 1 and 8, rejects 9', () => {
    expect(validateProfile(draft({ interests: [INTERESTS[0]] })).ok).toBe(true);
    expect(validateProfile(draft({ interests: [...INTERESTS] })).ok).toBe(true);
    expect(errorsOf(draft({ interests: [...INTERESTS, 'Cloud'] })).interests).toMatch(/at most 8/i);
  });

  it('rejects a topic picked twice', () => {
    expect(errorsOf(draft({ interests: ['Agents', 'Agents'] })).interests).toMatch(/already selected/);
  });

  it('reports every problem at once', () => {
    const errors = errorsOf({ display_name: '', industry: 'x', interests: [] });
    expect(Object.keys(errors).sort()).toEqual(['display_name', 'industry', 'interests']);
  });

  it('Scenario: Save is blocked without required fields', () => {
    expect(validateProfile(draft({ display_name: '' })).ok).toBe(false);
    expect(validateProfile(draft({ display_name: 'Maya', interests: [] })).ok).toBe(false);
    expect(validateProfile(draft()).ok).toBe(true);
  });
});

describe('normalizeTopic', () => {
  it('Scenario: Custom topic - "FINANCE" and "finance" are both saved as "Finance"', () => {
    for (const typed of ['FINANCE', 'finance', 'Finance', 'fINANCE', 'fInAnCe']) expect(normalizeTopic(typed)).toBe('Finance');
  });

  it('capitalizes only the first letter of several words', () => {
    expect(normalizeTopic('machine LEARNING')).toBe('Machine learning');
    expect(normalizeTopic('QUANTUM Computing Basics')).toBe('Quantum computing basics');
  });

  it('tidies spaces', () => {
    expect(normalizeTopic('  robotics  ')).toBe('Robotics');
    expect(normalizeTopic('data    science \n lab')).toBe('Data science lab');
  });

  it('gives a topic that matches a preset ignoring case the preset\'s own spelling', () => {
    expect(normalizeTopic('generative ai')).toBe('Generative AI');
    expect(normalizeTopic('CLOUD')).toBe('Cloud');
    expect(normalizeTopic('chips AND hardware')).toBe('Chips and hardware');
    expect(normalizeTopic('open SOURCE')).toBe('Open source');
  });

  it('lower-cases acronyms in a topic of the reader\'s own, as asked ("AI safety" -> "Ai safety")', () => {
    expect(normalizeTopic('AI safety')).toBe('Ai safety');
  });

  it('handles accents and emoji, and does not depend on the device language', () => {
    expect(normalizeTopic('ÉLAN')).toBe('Élan');
    expect(normalizeTopic('élan')).toBe('Élan');
    expect(normalizeTopic('\u{1F916} robots')).toBe('\u{1F916} robots');
    expect(normalizeTopic('\u00DFeta')).toBe('SSeta'); // plain upper-casing, the same on every phone
  });

  it('is empty for nothing', () => {
    expect(normalizeTopic('')).toBe('');
    expect(normalizeTopic('   ')).toBe('');
  });

  it('gives the same answer when applied again', () => {
    for (const typed of ['FINANCE', 'machine LEARNING', 'generative ai', 'ÉLAN']) {
      const once = normalizeTopic(typed);
      expect(normalizeTopic(once)).toBe(once);
    }
  });
});

describe('profile validation: topics of your own', () => {
  it('accepts a topic that is not a preset, and saves it normalized, in the same list as the presets', () => {
    const result = validateProfile(draft({ interests: ['Agents', 'FINANCE'] }));
    expect(result.ok && result.profile.interests).toEqual(['Agents', 'Finance']);
  });

  it('saves a topic that matches a preset under the preset\'s spelling', () => {
    const result = validateProfile(draft({ interests: ['generative ai'] }));
    expect(result.ok && result.profile.interests).toEqual(['Generative AI']);
  });

  it('rejects the same topic written two ways, and a custom topic that repeats a chosen preset', () => {
    expect(errorsOf(draft({ interests: ['finance', 'FINANCE'] })).interests).toMatch(/already selected/);
    expect(errorsOf(draft({ interests: ['Agents', 'agents'] })).interests).toMatch(/already selected/);
  });

  it('asks for text when "Other" is chosen but nothing is typed', () => {
    expect(errorsOf(draft({ interests: ['Agents', ''] })).interests).toBe('Type your topic.');
    expect(errorsOf(draft({ interests: ['Agents', '   '] })).interests).toBe('Type your topic.');
  });

  it('does not save the word "Other" as a topic', () => {
    expect(errorsOf(draft({ interests: [OTHER_TOPIC] })).interests).toMatch(/specific topic/);
    expect(errorsOf(draft({ interests: ['other'] })).interests).toMatch(/specific topic/);
  });

  it('accepts a custom topic of 30 characters and rejects 31', () => {
    expect(validateProfile(draft({ interests: ['x'.repeat(CUSTOM_TOPIC_MAX)] })).ok).toBe(true);
    expect(errorsOf(draft({ interests: ['x'.repeat(CUSTOM_TOPIC_MAX + 1)] })).interests).toMatch(/30 characters/);
  });

  it('counts a custom topic towards the limit of 8', () => {
    const seven = INTERESTS.slice(0, 7) as string[];
    expect(validateProfile(draft({ interests: [...seven, 'Finance'] })).ok).toBe(true);
    expect(errorsOf(draft({ interests: [...INTERESTS, 'Finance'] })).interests).toMatch(/at most 8/);
  });

  it('counts characters the way a person does', () => {
    expect(validateProfile(draft({ interests: ['\u{1F600}'.repeat(CUSTOM_TOPIC_MAX)] })).ok).toBe(true);
  });
});

describe('toggleInterest', () => {
  it('adds and removes', () => {
    expect(toggleInterest([], 'Cloud')).toEqual({ interests: ['Cloud'], refused: false });
    expect(toggleInterest(['Cloud', 'Agents'], 'Cloud')).toEqual({ interests: ['Agents'], refused: false });
  });

  it('treats "Other" like any chip: it holds a place, and a ninth chip is refused', () => {
    const sevenAndOther = [...(INTERESTS.slice(0, 7) as string[]), OTHER_TOPIC];
    expect(toggleInterest(sevenAndOther, INTERESTS[7])).toEqual({ interests: sevenAndOther, refused: true });
    const eight = INTERESTS.slice(0, INTERESTS_MAX) as string[];
    expect(toggleInterest(eight, OTHER_TOPIC)).toEqual({ interests: eight, refused: true });
    expect(toggleInterest(eight.slice(0, 7), OTHER_TOPIC).interests).toEqual([...eight.slice(0, 7), OTHER_TOPIC]);
    expect(toggleInterest(sevenAndOther, OTHER_TOPIC).interests).toEqual(eight.slice(0, 7));
  });

  it('Scenario: Interest limit - a ninth is refused and nothing changes', () => {
    const eight = INTERESTS.slice(0, INTERESTS_MAX) as string[];
    const result = toggleInterest(eight, 'Extra topic');
    expect(result).toEqual({ interests: eight, refused: true });
    expect(result.interests).not.toBe(eight);
  });

  it('still lets the user remove one when at the limit', () => {
    const eight = INTERESTS.slice(0, INTERESTS_MAX) as string[];
    expect(toggleInterest(eight, eight[0]).interests).toHaveLength(7);
  });
});
