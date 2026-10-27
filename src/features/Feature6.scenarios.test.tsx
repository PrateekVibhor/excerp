// Runs every Gherkin scenario in intent-6.md and spec-6.md against the real screens:
// Profile tab, reader profile, the InMail sheet that replaced the Connect box in Feature 7, tab bar, Feed, Reading List and Article Detail,
// with the mock article source, the AsyncStorage mock for the device store, and a router that
// records navigation. To "follow" a navigation, the target screen is rendered with the arguments
// of the push. Every scenario also fails if any screen makes a network request.
import * as fs from 'fs';
import * as path from 'path';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ComponentProps, ReactElement } from 'react';
import { Keyboard, TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { ReactTestInstance } from 'react-test-renderer';
import { act, create } from 'react-test-renderer';
import { GlassTabBar } from '../components/GlassTabBar';
import { articleRepository, INTERESTS, LOCAL_USER_ID, readingListRepository } from '../data';
import { createMockRepositories } from '../data/mockRepository';
import { ArticleDetailScreen } from './article/ArticleDetailScreen';
import { FeedScreen } from './feed/FeedScreen';
import { ProfileScreen } from './profile/ProfileScreen';
import { toggleInterest } from './profile/validation';
import { ReadingListScreen } from './readingList/ReadingListScreen';

const mockRouter = {
  push: jest.fn(),
  back: jest.fn(),
  replace: jest.fn(),
  navigate: jest.fn(),
  canGoBack: jest.fn(),
};
let mockParams: Record<string, string> = {};

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(), ImpactFeedbackStyle: { Light: 'light' } }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (cb: () => void) => require('react').useEffect(cb, [cb]),
  Tabs: () => null,
}));

const metrics = {
  frame: { x: 0, y: 0, width: 402, height: 874 },
  insets: { top: 62, left: 0, right: 0, bottom: 34 },
};
const tabProps = (index: number) =>
  ({
    state: {
      index,
      routes: [
        { key: 'feed', name: 'feed' },
        { key: 'reading-list', name: 'reading-list' },
        { key: 'profile', name: 'profile' },
      ],
    },
    navigation: { emit: () => ({ defaultPrevented: false }), navigate: jest.fn() },
  }) as unknown as ComponentProps<typeof GlassTabBar>;

let articles: Awaited<ReturnType<ReturnType<typeof createMockRepositories>['articles']['getFeed']>>;
let fetchSpy: jest.Mock;
let realFetch: typeof fetch;

beforeAll(async () => {
  articles = await createMockRepositories().articles.getFeed('x');
});
beforeEach(async () => {
  jest.clearAllMocks();
  jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
  mockRouter.canGoBack.mockReturnValue(true);
  mockParams = {};
  await AsyncStorage.clear();
  realFetch = global.fetch;
  fetchSpy = jest.fn();
  global.fetch = fetchSpy as unknown as typeof fetch;
});
afterEach(() => {
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

function texts(node: ReturnType<ReturnType<typeof create>['toJSON']>): string[] {
  if (node === null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap((n) => texts(n as never));
  return (node.children ?? []).flatMap((c) => texts(c as never));
}

/** Renders a screen and gives helpers to use it. */
async function mount(screen: ReactElement) {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<SafeAreaProvider initialMetrics={metrics}>{screen}</SafeAreaProvider>);
  });
  await act(async () => {});
  const find = (label: string) =>
    renderer.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
  const all = () => texts(renderer.toJSON() as never);
  return {
    renderer,
    text: all,
    has: (text: string) => all().includes(text),
    hasControl: (label: string) => find(label).length > 0,
    press: async (label: string) => {
      const target = find(label)[0];
      if (!target) throw new Error(`Nothing to press labelled "${label}"`);
      await act(async () => {
        target.props.onPress();
      });
      await act(async () => {});
    },
    type: async (value: string) => {
      await act(async () => {
        renderer.root.findByProps({ accessibilityLabel: 'Name', placeholder: 'Jordan Lee' }).props.onChangeText(value);
      });
    },
    typeInto: async (label: string, value: string) => {
      await act(async () => {
        renderer.root.findAll((n: ReactTestInstance) => n.type === TextInput && n.props.accessibilityLabel === label)[0].props.onChangeText(value);
      });
    },
    hasField: (label: string) => renderer.root.findAll((n: ReactTestInstance) => n.type === TextInput && n.props.accessibilityLabel === label).length > 0,
    inputs: () => renderer.root.findAll((n: ReactTestInstance) => typeof n.props.onChangeText === 'function'),
    isDisabled: (label: string) =>
      renderer.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === label && n.props.accessibilityRole === 'button')[0]
        ?.props.disabled === true,
    close: () => act(() => renderer.unmount()),
  };
}
type Screen = Awaited<ReturnType<typeof mount>>;

async function setUpProfile(screen: Screen, name = 'Maya Chen', industry = 'Software', topics = ['Agents', 'Cloud']) {
  await screen.type(name);
  await screen.press('Industry, Other');
  await screen.press(industry);
  for (const topic of topics) await screen.press(topic);
  await screen.press('Save profile');
}
const storedProfile = async () => JSON.parse((await AsyncStorage.getItem('swipy:profile')) ?? 'null');

describe('intent-6: Profile setup', () => {
  it('Scenario: Set up a profile', async () => {
    const screen = await mount(<ProfileScreen />); // the user opens the Profile tab
    await setUpProfile(screen); // enters a name, picks an industry, selects topics, and saves
    for (const shown of ['Maya Chen', 'Software', 'Agents', 'Cloud']) expect(screen.has(shown)).toBe(true); // the choices are shown
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('Scenario: Profile persists', async () => {
    const first = await mount(<ProfileScreen />);
    await setUpProfile(first); // a profile has been saved
    await first.close(); // the app is closed...
    const second = await mount(<ProfileScreen />); // ...and reopened
    for (const shown of ['Maya Chen', 'Software', 'Agents', 'Cloud']) expect(second.has(shown)).toBe(true);
    expect(second.hasControl('Save profile')).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('Scenario: Tab bar has three tabs', async () => {
    const screen = await mount(<GlassTabBar {...tabProps(0)} />);
    for (const label of ['Feed', 'Reading List', 'Profile']) expect(screen.has(label)).toBe(true);
    const tabs = screen.renderer.root.findAll((n: ReactTestInstance) => n.props.accessibilityRole === 'tab' && typeof n.props.onPress === 'function');
    expect(tabs).toHaveLength(3);
  });
});

describe('spec-6: Profile setup (spec level)', () => {
  it('Scenario: Save is blocked without required fields', async () => {
    const screen = await mount(<ProfileScreen />);
    expect(screen.isDisabled('Save profile')).toBe(true); // the name is empty
    await screen.type('Maya');
    expect(screen.isDisabled('Save profile')).toBe(true); // a name is entered but no interest
    await screen.press('Agents');
    expect(screen.isDisabled('Save profile')).toBe(false);
    expect(await storedProfile()).toBeNull(); // nothing was saved by the blocked attempts
  });

  it('Scenario: Name length', async () => {
    const screen = await mount(<ProfileScreen />);
    await screen.press('Agents');
    await screen.type('x'.repeat(41)); // a name of 41 characters
    expect(screen.has('Use 40 characters or fewer.')).toBe(true); // is rejected with a message
    expect(screen.isDisabled('Save profile')).toBe(true);
    await screen.type('x'.repeat(40));
    expect(screen.isDisabled('Save profile')).toBe(false); // 40 is fine
  });

  it('Scenario: Interest limit', async () => {
    const screen = await mount(<ProfileScreen />);
    for (const interest of INTERESTS) await screen.press(interest); // 8 interests are selected
    expect(screen.has('8 of 8 selected')).toBe(true);
    await screen.press('Other'); // the user tries to select a ninth
    expect(screen.has('You can pick up to 8 topics.')).toBe(true); // the selection is refused
    expect(screen.hasField('Your topic')).toBe(false);
    expect(toggleInterest(INTERESTS, 'A ninth topic').refused).toBe(true); // and the rule itself agrees
  });

  it('Scenario: Other topic is saved like a preset, tidied to one spelling', async () => {
    const first = await mount(<ProfileScreen />);
    await first.type('Maya Chen');
    await first.press('Agents');
    await first.press('Other'); // the user selects "Other"
    expect(first.hasField('Your topic')).toBe(true); // a field appears to type in
    await first.typeInto('Your topic', 'FINANCE');
    await first.press('Save profile');
    // saved in the same list as the presets, as "Finance", and never as the word "Other"
    expect((await storedProfile()).interests).toEqual(['Agents', 'Finance']);
    expect(first.has('Finance')).toBe(true); // shown on the Profile screen like any topic
    await first.close();

    const second = await mount(<ProfileScreen />); // after closing and reopening
    expect(second.has('Finance')).toBe(true);
    await second.press('Edit profile'); // editing brings it back under "Other"
    expect(second.hasField('Your topic')).toBe(true);
    await second.typeInto('Your topic', 'finance'); // typed another way: stored the same way
    await second.press('Save profile');
    expect((await storedProfile()).interests).toEqual(['Agents', 'Finance']);
  });

  it('Scenario: Edit overwrites', async () => {
    const screen = await mount(<ProfileScreen />);
    await setUpProfile(screen); // a saved profile
    await screen.press('Edit profile');
    await screen.press('Industry, Software'); // the user changes the industry
    await screen.press('Finance');
    await screen.press('Save profile'); // and saves
    expect(screen.hasControl('Save profile')).toBe(false); // the form closes
    expect(screen.hasControl('Edit profile')).toBe(true);
    expect(await storedProfile()).toEqual({ display_name: 'Maya Chen', industry: 'Finance', interests: ['Agents', 'Cloud'] }); // only the new industry is stored
  });

  it('Scenario: Feed is unaffected', async () => {
    const before = await articleRepository.getFeed(LOCAL_USER_ID);
    const plain = await mount(<FeedScreen />); // the Feed with no profile
    const plainText = plain.text();
    await plain.close();

    const profile = await mount(<ProfileScreen />);
    await setUpProfile(profile, 'Maya Chen', 'Software', ['Generative AI', 'Safety']); // a profile with interests is saved
    await profile.close();

    const after = await articleRepository.getFeed(LOCAL_USER_ID);
    expect(after.map((a) => a.id)).toEqual(before.map((a) => a.id)); // the order is the same
    const feed = await mount(<FeedScreen />); // when the Feed is opened
    expect(feed.text()).toEqual(plainText);
  });

  it('Scenario: No network use - editing a profile makes no network request', async () => {
    const screen = await mount(<ProfileScreen />);
    await setUpProfile(screen);
    await screen.press('Edit profile');
    await screen.press('Cancel');
    expect(fetchSpy).not.toHaveBeenCalled(); // no network request is made by the Profile feature
  });
});

describe('plan-6: Delivery of the Profile setup plan', () => {
  it('Scenario: Scope stays closed - the Profile setup code has no sign-in, network or Feed ranking', () => {
    const dir = path.join(__dirname, 'profile');
    const sources = fs
      .readdirSync(dir)
      // The pages about other readers (a reader's profile, the message sheet, blocked readers) came with Plan 15 and have their own tests.
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f) && !/^(ReaderProfileScreen|InMailSheet|BlockedReadersScreen)\./.test(f))
      .map((f) => ({ f, source: fs.readFileSync(path.join(dir, f), 'utf8') }));
    expect(sources.length).toBeGreaterThan(5);
    for (const { f, source } of sources) {
      expect(source).not.toMatch(/\bfetch\b|XMLHttpRequest|WebSocket|axios/); // no network
      expect(source).not.toMatch(/sign.?in|sign.?out|log.?in|oauth|password|google|apple.?auth/i); // no sign-in
      // no Feed ranking; countByTopic (Feature 10) orders topic counts for the Verified stats, which is not ranking articles
      if (f !== 'countByTopic.ts') expect(source).not.toMatch(/\brank|getFeed|articleRepository|sort\(/i);
    }
  });

  it('shows no sign-in controls on the Profile tab', async () => {
    const all = (await mount(<ProfileScreen />)).text().join(' ');
    expect(all).not.toMatch(/sign in|sign-in|sign out|log in|google|password/i);
  });
});
