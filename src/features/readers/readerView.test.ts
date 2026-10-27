import { avatarOf, toListReader, toneOf } from './readerView';

describe('readerView', () => {
  it('the avatar color comes from the public id: the same every time, one of three', () => {
    const tones = new Set<number>();
    for (let i = 0; i < 60; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      expect(toneOf(id)).toBe(toneOf(id));
      expect([0, 1, 2]).toContain(toneOf(id));
      tones.add(toneOf(id));
    }
    expect(tones.size).toBe(3);
  });
  it('initials come from the name, with a question mark for no name', () => {
    expect(avatarOf('Maya Chen', 'x').initials).toBe('MC');
    expect(avatarOf('Reader', 'x').initials).toBe('R');
    expect(avatarOf('   ', 'x').initials).toBe('?');
  });
  it('a reader from the server becomes a list row keyed by the public id', () => {
    expect(toListReader({ public_id: 'p1', display_name: 'Bob Jones', industry: 'Finance' })).toEqual({ id: 'p1', name: 'Bob Jones', industry: 'Finance', avatar: { initials: 'BJ', tone: toneOf('p1') } });
  });
});
