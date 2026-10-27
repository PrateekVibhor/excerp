// Gherkin scenarios of spec-4.md that need the "api" data source:
// "Backend unreachable" and "Retry recovers". The environment is set before the
// data module is first loaded, so the app starts configured for the API.
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ReactTestInstance } from 'react-test-renderer';
import { act, create } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { createMockRepositories } from '../../data/mockRepository';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(), ImpactFeedbackStyle: { Light: 'light' } }));
jest.mock('expo-router', () => ({ useRouter: () => ({ navigate: jest.fn() }), Tabs: () => null }));

const fetchMock = jest.fn();
process.env.EXPO_PUBLIC_DATA_SOURCE = 'api';
process.env.EXPO_PUBLIC_API_URL = 'https://api.example.test';
(global as { fetch: unknown }).fetch = fetchMock;
// Loaded after the environment above is in place.
const { FeedScreen } = require('./FeedScreen') as typeof import('./FeedScreen');

const metrics = {
  frame: { x: 0, y: 0, width: 402, height: 874 },
  insets: { top: 62, left: 0, right: 0, bottom: 34 },
};

let mockTitles: string[];
let serverFeed: unknown[];

beforeAll(async () => {
  const feed = await createMockRepositories().articles.getFeed('x');
  mockTitles = feed.map((a) => a.title);
  // What a real server would return: one article the mock data does not have.
  serverFeed = [{ ...feed[0], id: 'srv-1', title: 'Served by the backend', published_at: '2026-10-03T00:00:00Z' }];
});
beforeEach(async () => {
  jest.useFakeTimers();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  fetchMock.mockReset();
  await AsyncStorage.clear();
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function texts(node: ReturnType<ReturnType<typeof create>['toJSON']>): string[] {
  if (node === null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap((n) => texts(n as never));
  return (node.children ?? []).flatMap((c) => texts(c as never));
}
const instanceTexts = (n: ReactTestInstance | string): string[] =>
  typeof n === 'string' ? [n] : n.children.flatMap((c) => instanceTexts(c as ReactTestInstance | string));

async function launch() {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <SafeAreaProvider initialMetrics={metrics}>
        <FeedScreen />
      </SafeAreaProvider>,
    );
  });
  await act(async () => {});
  return { renderer, text: () => texts(renderer.toJSON() as never) };
}

const down = () => fetchMock.mockRejectedValue(new TypeError('Network request failed'));
const up = () =>
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => serverFeed } as unknown as Response);

describe('spec-4: data source "api"', () => {
  it('Scenario: Backend unreachable', async () => {
    down();
    const app = await launch();
    const t = app.text();
    expect(t).toContain("Couldn't load your feed");
    expect(t).toContain('Retry');
    for (const title of mockTitles) expect(t).not.toContain(title); // no mock data shown
    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toContain('https://api.example.test/feed');
  });

  it('Scenario: Retry recovers', async () => {
    down();
    const app = await launch();
    expect(app.text()).toContain("Couldn't load your feed");

    up(); // the server is back
    const retry = app.renderer.root
      .findAll((n) => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')
      .find((n) => instanceTexts(n).includes('Retry'));
    expect(retry).toBeDefined();
    await act(async () => retry!.props.onPress());
    await act(async () => {});

    const t = app.text();
    expect(t).not.toContain("Couldn't load your feed");
    expect(t).toContain('Served by the backend'); // cards are shown
    expect(t).toContain('1 / 1');
  });

  it('Scenario: the loading state shows until the server answers', async () => {
    let answer!: (r: unknown) => void;
    fetchMock.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const app = await launch();
    expect(app.text()).toContain('Loading your feed');
    await act(async () => answer({ ok: true, status: 200, json: async () => serverFeed }));
    await act(async () => {});
    expect(app.text()).toContain('Served by the backend');
  });
});
