// One value says how much room a screen under the floating tab bar leaves below its last row, and every such screen uses it: nothing is hidden behind the bar, and the last
// row (or the building screen's error line and its Try again button) can always be scrolled clear of it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { actions, bottomClear, feed, list, profile, tab, tabBar, tabBarTop } from './layout';

const root = join(__dirname, '../..');
const source = (path: string) => readFileSync(join(root, path), 'utf8');

describe('the room under the floating tab bar', () => {
  it('knows where the top of the bar is: its offset from the bottom safe area, its tab height, its padding and its border', () => {
    expect(tabBarTop).toBe(tabBar.bottomOffset + tab.height + tabBar.padding * 2 + 2);
    expect(tabBarTop).toBe(92);
  });

  it('leaves a gap above the bar, not just the bar itself', () => {
    expect(bottomClear).toBeGreaterThanOrEqual(tabBarTop + 40);
  });

  it('is the one value the scrolling screens already used, so the same distance is left everywhere (no second number)', () => {
    expect(list.bottomClear).toBe(bottomClear);
    expect(profile.bottomClear).toBe(bottomClear);
  });

  it('the feed leaves room too: the cards and the Skip and Save buttons end above the bar', () => {
    expect(feed.cardAreaBottom).toBeGreaterThanOrEqual(tabBarTop);
    expect(actions.bottomAboveSafeArea).toBeGreaterThanOrEqual(tabBarTop);
  });

  it.each([
    'src/features/readingList/ReadingListScreen.tsx',
    'src/features/profile/ProfileScreen.tsx',
    'src/features/courses/CourseHomeScreen.tsx',
    'src/features/courses/BuildingScreen.tsx',
  ])('%s uses it (the shared hook), and does not make up its own distance', (file) => {
    const code = source(file);
    expect(code).toContain("from '../../components/useBottomClear'");
    expect(code).toMatch(/useBottomClear\(\)/);
    expect(code).not.toMatch(/insets\.bottom \+ (?:list|profile)\.bottomClear|insets\.bottom \+ (?:3[0-9]|4[0-9])\b/);
  });
});
