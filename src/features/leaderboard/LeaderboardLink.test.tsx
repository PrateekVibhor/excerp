import * as fs from 'fs';
import * as path from 'path';
import { Text } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { act, create } from 'react-test-renderer';
import { LeaderboardLink } from './LeaderboardLink';

jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));

const root = path.join(__dirname, '../../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('LeaderboardLink', () => {
  const mount = (onPress = jest.fn()) => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LeaderboardLink onPress={onPress} />);
    });
    return { renderer, onPress };
  };

  it('is a button called Leaderboard, with a line about what it is and that the name is shown there', () => {
    const { renderer } = mount();
    const button = renderer.root.find((n: ReactTestInstance) => n.props.accessibilityLabel === 'Leaderboard' && n.props.accessibilityRole === 'button' && typeof n.type !== 'string');
    expect(button).toBeDefined();
    const texts = renderer.root.findAllByType(Text).map((t) => [t.props.children].flat().join(''));
    expect(texts).toEqual(['Leaderboard', 'Who has verified the most articles. Your name is shown there.']);
  });

  it('calls what it was given when pressed, once', () => {
    const { renderer, onPress } = mount();
    act(() => renderer.root.find((n: ReactTestInstance) => n.props.accessibilityLabel === 'Leaderboard' && typeof n.props.onPress === 'function' && typeof n.type !== 'string').props.onPress());
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('lets its text wrap and grow rather than fixing its height, for large text sizes', () => {
    const { renderer } = mount();
    const row = renderer.root.find((n: ReactTestInstance) => n.props.accessibilityLabel === 'Leaderboard' && typeof n.type !== 'string');
    const style = Object.assign({}, ...[row.props.style].flat(2).filter(Boolean));
    expect(style.height).toBeUndefined();
    expect(style.minHeight).toBeGreaterThanOrEqual(64);
  });
});

describe('Scenario: Tab bar has no Leaderboard tab', () => {
  it('the tab layout has Feed, Reading List, Skills list and Profile, and no Leaderboard tab', () => {
    const layout = read('app/(tabs)/_layout.tsx');
    const screens = [...layout.matchAll(/<Tabs\.Screen name="([^"]+)"/g)].map((m) => m[1]);
    expect(screens).toEqual(['feed', 'reading-list', 'lists', 'profile']);
  });

  it('the leaderboard is a screen of its own outside the tabs, reached from Profile', () => {
    expect(fs.existsSync(path.join(root, 'app/leaderboard.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'app/(tabs)/leaderboard.tsx'))).toBe(false);
    expect(read('app/leaderboard.tsx')).toMatch(/export default function/);
    expect(read('src/features/profile/ProfileScreen.tsx')).toContain("router.push('/leaderboard')");
  });
});
