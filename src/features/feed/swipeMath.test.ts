import {
  buttonScale,
  dampedY,
  decideSwipe,
  dragProgress,
  labelScale,
  rotationDeg,
  saveProgress,
  skipProgress,
  stackOpacity,
  stackQ,
  stackScale,
  stackTranslateY,
} from './swipeMath';

describe('decideSwipe (threshold is 110 points)', () => {
  it('springs back at 109 points right and flies off at 111', () => {
    expect(decideSwipe(109)).toBeNull();
    expect(decideSwipe(111)).toBe('right');
  });

  it('does the same to the left', () => {
    expect(decideSwipe(-109)).toBeNull();
    expect(decideSwipe(-111)).toBe('left');
  });

  it('treats exactly 110 as not past the threshold', () => {
    expect(decideSwipe(110)).toBeNull();
    expect(decideSwipe(-110)).toBeNull();
  });

  it('ignores no movement', () => {
    expect(decideSwipe(0)).toBeNull();
  });
});

describe('feedback progress', () => {
  it('grows to 1 at the threshold and stays there', () => {
    expect(saveProgress(55)).toBeCloseTo(0.5);
    expect(saveProgress(110)).toBe(1);
    expect(saveProgress(400)).toBe(1);
  });

  it('only the matching direction lights up', () => {
    expect(saveProgress(-80)).toBe(0);
    expect(skipProgress(80)).toBe(0);
    expect(skipProgress(-55)).toBeCloseTo(0.5);
  });

  it('label scale runs from 0.8 to 1', () => {
    expect(labelScale(0)).toBeCloseTo(0.8);
    expect(labelScale(1)).toBeCloseTo(1);
  });
});

describe('drag mapping', () => {
  it('damps vertical movement to 0.6', () => {
    expect(dampedY(100)).toBeCloseTo(60);
  });

  it('rotates in proportion to horizontal drag', () => {
    expect(rotationDeg(100)).toBeCloseTo(5.5);
    expect(rotationDeg(-100)).toBeCloseTo(-5.5);
  });
});

describe('stack', () => {
  it('a card one place back rises to the top as the top card leaves', () => {
    expect(stackQ(1, 0)).toBe(1);
    expect(stackQ(1, 0.5)).toBeCloseTo(0.5);
    expect(stackQ(1, 1)).toBe(0);
  });

  it('never goes in front of the top position', () => {
    expect(stackQ(1, 1)).toBe(0);
    expect(stackQ(0, 1)).toBe(0);
  });

  it('offsets 15 points and shrinks 5 percent per step', () => {
    expect(stackTranslateY(1)).toBe(15);
    expect(stackTranslateY(2)).toBe(30);
    expect(stackScale(1)).toBeCloseTo(0.95);
    expect(stackScale(2)).toBeCloseTo(0.9);
  });

  it('fades only cards more than one step back', () => {
    expect(stackOpacity(0)).toBe(1);
    expect(stackOpacity(1)).toBe(1);
    expect(stackOpacity(2)).toBeCloseTo(0.7);
  });

  it('promotion is continuous: the position at full drag equals the next position', () => {
    // Before the swipe commits, a depth-1 card at full drag sits where a depth-0 card would.
    expect(stackTranslateY(stackQ(1, 1))).toBe(stackTranslateY(stackQ(0, 0)));
    expect(stackScale(stackQ(1, 1))).toBe(stackScale(stackQ(0, 0)));
  });
});

describe('drag progress and buttons', () => {
  it('is symmetric and clamped', () => {
    expect(dragProgress(55)).toBeCloseTo(0.5);
    expect(dragProgress(-55)).toBeCloseTo(0.5);
    expect(dragProgress(999)).toBe(1);
  });

  it('buttons grow up to 10 percent', () => {
    expect(buttonScale(0)).toBe(1);
    expect(buttonScale(1)).toBeCloseTo(1.1);
  });
});
