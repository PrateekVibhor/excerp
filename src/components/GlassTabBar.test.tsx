import type { ComponentProps } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { ReactTestInstance } from 'react-test-renderer';
import { act, create } from 'react-test-renderer';
import { Dimensions, Keyboard, Platform } from 'react-native';
import { GlassTabBar, tabWidth } from './GlassTabBar';
import { TabBadge } from './TabBadge';

let mockSavedCount = 0;
let mockNewCoverage = false;
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
jest.mock('expo-router', () => ({ Tabs: () => null }));
jest.mock('../features/readingList/useSavedCount', () => ({ useSavedCount: () => mockSavedCount }));
jest.mock('../features/courses/useNewCoverage', () => ({ useNewCoverage: () => mockNewCoverage }));

const metrics = {
  frame: { x: 0, y: 0, width: 375, height: 667 },
  insets: { top: 20, left: 0, right: 0, bottom: 0 },
};
const routes = [
  { key: 'feed', name: 'feed' },
  { key: 'reading-list', name: 'reading-list' },
  { key: 'lists', name: 'lists' },
  { key: 'profile', name: 'profile' },
];

function mount(index = 0) {
  const navigate = jest.fn();
  const props = {
    state: { index, routes },
    navigation: { emit: () => ({ defaultPrevented: false }), navigate },
  } as unknown as ComponentProps<typeof GlassTabBar>;
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <SafeAreaProvider initialMetrics={metrics}>
        <GlassTabBar {...props} />
      </SafeAreaProvider>,
    );
  });
  const tabs = renderer.root.findAll((n: ReactTestInstance) => n.props.accessibilityRole === 'tab' && typeof n.props.onPress === 'function');
  return { renderer, tabs, navigate };
}
const labelOf = (tab: ReactTestInstance) =>
  tab.findAll((n) => typeof n.children[0] === 'string').map((n) => n.children[0]).join('');

beforeEach(() => {
  mockSavedCount = 0;
  mockNewCoverage = false;
});

describe('GlassTabBar', () => {
  it('Scenario: Tab bar has four tabs - Feed, Reading List, Skills list and Profile, in that order', () => {
    const { tabs } = mount();
    expect(tabs).toHaveLength(4);
    expect(tabs.map(labelOf)).toEqual(['Feed', 'Reading List', 'Skills list', 'Profile']);
  });

  it('marks only the open tab as selected', () => {
    const { tabs } = mount(2);
    expect(tabs.map((t) => t.props.accessibilityState.selected)).toEqual([false, false, true, false]);
  });

  it('opens a tab when it is pressed, but not the one already open', () => {
    const { tabs, navigate } = mount(0);
    act(() => tabs[2].props.onPress());
    expect(navigate).toHaveBeenCalledWith('lists');
    act(() => tabs[3].props.onPress());
    expect(navigate).toHaveBeenCalledWith('profile');
    act(() => tabs[0].props.onPress());
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it('keeps the saved-count badge on Reading List only', () => {
    mockSavedCount = 4;
    const { renderer, tabs } = mount();
    const badges = renderer.root.findAllByType(TabBadge);
    expect(badges).toHaveLength(1);
    expect(badges[0].props.count).toBe(4);
    expect(tabs[1].findAllByType(TabBadge)).toHaveLength(1);
    expect(tabs[0].findAllByType(TabBadge)).toHaveLength(0);
    expect(tabs[2].findAllByType(TabBadge)).toHaveLength(0);
    expect(tabs[3].findAllByType(TabBadge)).toHaveLength(0);
  });

  it('shows a dot on Skills list when any list has new coverage, and nowhere else', () => {
    mockNewCoverage = true;
    const { tabs } = mount();
    const dotted = tabs.map((t) => t.findAll((n) => n.props.accessibilityLabel === 'New coverage' && typeof n.type === 'string').length);
    expect(dotted).toEqual([0, 0, 1, 0]);
  });

  it('shows no dot when there is nothing new', () => {
    const { tabs } = mount();
    expect(tabs.flatMap((t) => t.findAll((n) => n.props.accessibilityLabel === 'New coverage')).length).toBe(0);
  });

  describe('four tabs fit the narrowest phone', () => {
    const sizes = [320, 375, 390, 430];
    const spy = (width: number) => jest.spyOn(Dimensions, 'get').mockReturnValue({ width, height: 800, scale: 2, fontScale: 1 });
    afterEach(() => jest.restoreAllMocks());

    it('the tab width shrinks to fit, never passing its full size, with a margin each side', () => {
      expect(tabWidth(375, 4)).toBe(82);
      expect(tabWidth(320, 4)).toBe(68);
      expect(tabWidth(430, 4)).toBe(96);
      expect(tabWidth(430, 3)).toBe(104);
      for (const w of sizes) {
        const total = tabWidth(w, 4) * 4 + 3 * 4 + 2 * 5;
        expect(total).toBeLessThanOrEqual(w - 24);
      }
    });

    it.each(sizes)('at %ipt wide the four tabs are as wide as that says', (w) => {
      spy(w);
      const { tabs } = mount();
      const style = (t: ReactTestInstance) => Object.assign({}, ...[t.props.style].flat(3).filter(Boolean)) as { width: number };
      expect(tabs.map((t) => style(t).width)).toEqual([tabWidth(w, 4), tabWidth(w, 4), tabWidth(w, 4), tabWidth(w, 4)]);
    });

    it('a label that does not fit shrinks to one line instead of wrapping', () => {
      const { renderer } = mount();
      const labels = renderer.root.findAll((n) => n.props.numberOfLines === 1 && n.props.adjustsFontSizeToFit === true);
      expect(labels.length).toBeGreaterThanOrEqual(4);
    });
  });

  it('steps aside while the keyboard is up, so the floating bar never sits over the field being typed in, and comes back after', () => {
    const handlers = new Map<string, Array<() => void>>();
    const spy = jest.spyOn(Keyboard, 'addListener').mockImplementation(((name: string, fn: () => void) => {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
      return { remove: () => handlers.set(name, (handlers.get(name) ?? []).filter((h) => h !== fn)) };
    }) as never);
    const { renderer } = mount();
    const tabCount = () => renderer.root.findAll((n: ReactTestInstance) => n.props.accessibilityRole === 'tab' && typeof n.props.onPress === 'function').length;
    expect(tabCount()).toBe(4);
    const [show, hide] = Platform.OS === 'ios' ? ['keyboardWillShow', 'keyboardWillHide'] : ['keyboardDidShow', 'keyboardDidHide'];
    act(() => (handlers.get(show) ?? []).forEach((h) => h()));
    expect(tabCount()).toBe(0);
    act(() => (handlers.get(hide) ?? []).forEach((h) => h()));
    expect(tabCount()).toBe(4);
    spy.mockRestore();
  });
});
