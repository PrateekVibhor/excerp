import { badgeLabel, shouldPop } from './badge';

describe('badgeLabel', () => {
  it('is hidden at zero', () => {
    expect(badgeLabel(0)).toBeNull();
    expect(badgeLabel(-1)).toBeNull();
  });

  it('shows the count', () => {
    expect(badgeLabel(1)).toBe('1');
    expect(badgeLabel(42)).toBe('42');
    expect(badgeLabel(99)).toBe('99');
  });

  it('caps large counts', () => {
    expect(badgeLabel(100)).toBe('99+');
  });

  it('can be capped lower: 9+ for the inbox', () => {
    expect(badgeLabel(9, 9)).toBe('9');
    expect(badgeLabel(10, 9)).toBe('9+');
    expect(badgeLabel(11, 9)).toBe('9+');
    expect(badgeLabel(0, 9)).toBeNull();
  });
});

describe('shouldPop', () => {
  it('pops only when the count rises', () => {
    expect(shouldPop(0, 1)).toBe(true);
    expect(shouldPop(3, 4)).toBe(true);
  });

  it('does not pop on the first value, on a drop, or when unchanged', () => {
    expect(shouldPop(null, 5)).toBe(false);
    expect(shouldPop(4, 3)).toBe(false);
    expect(shouldPop(2, 2)).toBe(false);
  });
});
