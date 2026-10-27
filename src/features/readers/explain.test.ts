import { explain, OFFLINE } from './explain';

describe('explain', () => {
  it('turns the server\'s short codes into plain sentences, and never shows a raw code', () => {
    for (const code of ['visibility_required', 'confirmation required', 'profile required', 'suspended', 'verify_first', 'already_requested', 'awaiting_acceptance', 'accept_first', 'closed', 'expired', 'deleted account', 'no links', 'repeated message', 'not found']) {
      const text = explain({ kind: 'refused', status: 400, code });
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/[a-z]+_[a-z]+/); // a raw code such as visibility_required never reaches the screen
    }
  });
  it('limits, unknown refusals, a lost session and a failure each get an honest sentence', () => {
    expect(explain({ kind: 'refused', status: 429, code: 'too many requests; try again later' })).toContain('limit');
    expect(explain({ kind: 'refused', status: 400, code: 'something new' })).toContain('could not be sent');
    expect(explain({ kind: 'refused', status: 404, code: 'something new' })).toBe(OFFLINE);
    expect(explain({ kind: 'unauthorized' })).toContain('sign in');
    expect(explain({ kind: 'failed' })).toBe(OFFLINE);
    expect(explain({ kind: 'failed' }, 'Custom')).toBe('Custom');
    expect(explain({ kind: 'ok', value: null })).toBe('');
  });
});
