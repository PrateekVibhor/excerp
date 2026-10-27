import AsyncStorage from '@react-native-async-storage/async-storage';
import { AccessibilityInfo, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { ReactTestInstance } from 'react-test-renderer';
import { act, create } from 'react-test-renderer';
import { useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { LOCAL_USER_ID, readingListRepository, verifiedRepository, type Article } from '../../data';
import { createMockRepositories } from '../../data/mockRepository';
import { CardStack } from '../feed/CardStack';
import { ReadingListRow } from '../readingList/ReadingListRow';
import { ReadingListScreen } from '../readingList/ReadingListScreen';
import { useVerifiedSet } from './useVerified';
import { VerifiedBadge } from './VerifiedBadge';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('react-native-reanimated', () => {
  const mock = require('react-native-reanimated/mock');
  return { ...mock, withSpring: jest.fn(mock.withSpring), withTiming: jest.fn(mock.withTiming) };
});
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(), notificationAsync: jest.fn(), ImpactFeedbackStyle: { Light: 'light' } }));
const mockRouter = { push: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

const metrics = { frame: { x: 0, y: 0, width: 402, height: 874 }, insets: { top: 62, left: 0, right: 0, bottom: 34 } };
const opened: Array<ReturnType<typeof create>> = [];
const labelled = (r: ReturnType<typeof create>, label: string) => r.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === label && typeof n.type !== 'string');
const texts = (r: ReturnType<typeof create>) => [...new Set(r.root.findAllByType(Text).map((t) => [t.props.children].flat().join('')))];

let articles: Article[];
beforeAll(async () => {
  articles = await createMockRepositories().articles.getFeed('u');
});
beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
});
afterEach(async () => {
  jest.restoreAllMocks();
  await act(async () => {
    opened.splice(0).forEach((r) => r.unmount());
  });
});

async function mount(ui: React.ReactElement) {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(ui);
  });
  await act(async () => {});
  opened.push(renderer);
  return renderer;
}

describe('VerifiedBadge', () => {
  it('has three sizes: a check, a pill with the word, and a large round badge, each labelled "Verified"', async () => {
    const mini = await mount(<VerifiedBadge size="mini" />);
    expect(labelled(mini, 'Verified').length).toBeGreaterThan(0);
    expect(texts(mini)).toEqual([]); // a check only
    const small = await mount(<VerifiedBadge />);
    expect(texts(small)).toEqual(['Verified']);
    const large = await mount(<VerifiedBadge size="large" />);
    expect(labelled(large, 'Verified').length).toBeGreaterThan(0);
  });

  it('the large badge animates in: a spring for the badge and a timed ring', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    await mount(<VerifiedBadge size="large" />);
    expect(withSpring).toHaveBeenCalledWith(1, expect.objectContaining({ damping: expect.any(Number) }));
    expect(withTiming).toHaveBeenCalledWith(1, expect.objectContaining({ duration: 750 }));
  });

  it('with Reduce Motion on, it does not animate', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    await mount(<VerifiedBadge size="large" />);
    expect(withSpring).not.toHaveBeenCalled();
    expect(withTiming).not.toHaveBeenCalled();
  });

  it('the small and mini badges are still, and the large one survives being removed before the motion setting is known', async () => {
    await mount(<VerifiedBadge />);
    await mount(<VerifiedBadge size="mini" />);
    expect(withSpring).not.toHaveBeenCalled();
    let resolve!: (v: boolean) => void;
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockReturnValue(new Promise<boolean>((r) => (resolve = r)));
    const large = await mount(<VerifiedBadge size="large" />);
    await act(async () => large.unmount());
    await act(async () => resolve(false)); // late answer: nothing happens
    expect(withSpring).not.toHaveBeenCalled();
  });
});

function Stack({ verifiedIds, list = articles }: { verifiedIds?: ReadonlySet<string>; list?: Article[] }) {
  const dragX = useSharedValue(0);
  return <CardStack articles={list} index={0} dragX={dragX} onSwipe={jest.fn()} verifiedIds={verifiedIds} />;
}

describe('Verified check on the card', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('shows a check beside the tag on the cards of verified articles only', async () => {
    const r = await mount(<Stack verifiedIds={new Set([articles[0].id, articles[2].id])} />);
    const checks = labelled(r, 'Verified').filter((n) => n.props.accessible);
    expect(checks).toHaveLength(2); // the cards for articles 0 and 2 are in the stack of three
  });

  it('shows none when nothing is verified, or when no list is given', async () => {
    expect(labelled(await mount(<Stack verifiedIds={new Set()} />), 'Verified')).toHaveLength(0);
    expect(labelled(await mount(<Stack />), 'Verified')).toHaveLength(0);
  });

  it('keeps the long publisher name and the tag on the card next to the check', async () => {
    const long = { ...articles[0], source_company: 'MIT Sloan Management Review', content_type: 'Venture Capital' } as unknown as Article;
    const r = await mount(<Stack list={[long]} verifiedIds={new Set([long.id])} />);
    expect(texts(r)).toEqual(expect.arrayContaining(['MIT Sloan Management Review', 'Venture Capital']));
    expect(labelled(r, 'Verified').length).toBeGreaterThan(0);
    const name = r.root.findAllByType(Text).find((t) => t.props.children === 'MIT Sloan Management Review')!;
    expect(name.props.numberOfLines).toBe(1);
  });
});

describe('Verified check on the Reading List row', () => {
  const entry = (a: Article) => ({ item: { id: 'i', user_id: 'u', article_id: a.id, saved_at: '2026-10-04T10:00:00.000Z' }, article: a }) as never;

  it('shows a check after the tag when verified, and not otherwise', async () => {
    const yes = await mount(<ReadingListRow entry={entry(articles[0])} verified />);
    expect(labelled(yes, 'Verified').length).toBeGreaterThan(0);
    const no = await mount(<ReadingListRow entry={entry(articles[0])} />);
    expect(labelled(no, 'Verified')).toHaveLength(0);
  });

  it('shows none for an article that is no longer available', async () => {
    const gone = await mount(<ReadingListRow entry={{ item: { id: 'i', user_id: 'u', article_id: 'x', saved_at: '2026-10-04T10:00:00.000Z' }, article: undefined } as never} verified />);
    expect(labelled(gone, 'Verified')).toHaveLength(0);
  });
});

describe('Reading List screen', () => {
  const show = () =>
    mount(
      <SafeAreaProvider initialMetrics={metrics}>
        <ReadingListScreen />
      </SafeAreaProvider>,
    );

  it('marks the verified rows, and only those', async () => {
    await readingListRepository.add(LOCAL_USER_ID, 'mock-1');
    await readingListRepository.add(LOCAL_USER_ID, 'mock-2');
    await verifiedRepository.add('mock-2', 'Generative AI');
    const r = await show();
    expect(labelled(r, 'Verified').filter((n) => n.props.accessible)).toHaveLength(1);
  });

  it('Scenario: Badge survives removal - a verified article taken off the list is still verified, and back on the list it is marked again', async () => {
    await readingListRepository.add(LOCAL_USER_ID, 'mock-1');
    await verifiedRepository.add('mock-1', 'Research');
    const r = await show();
    expect(labelled(r, 'Verified').length).toBeGreaterThan(0);
    await act(async () => {
      r.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === 'Remove' && typeof n.props.onPress === 'function')[0].props.onPress();
    });
    await act(async () => {});
    expect(labelled(r, 'Verified')).toHaveLength(0); // no row left to mark
    expect(await verifiedRepository.isVerified('mock-1')).toBe(true); // the record is kept
    await readingListRepository.add(LOCAL_USER_ID, 'mock-1');
    const again = await show();
    expect(labelled(again, 'Verified').length).toBeGreaterThan(0);
  });

  it('a mark appears when the quiz is passed while the list is open', async () => {
    await readingListRepository.add(LOCAL_USER_ID, 'mock-3');
    const r = await show();
    expect(labelled(r, 'Verified')).toHaveLength(0);
    await act(async () => {
      await verifiedRepository.add('mock-3', 'Cloud');
    });
    await act(async () => {});
    expect(labelled(r, 'Verified').length).toBeGreaterThan(0);
  });

  it('an unreadable verified store means no marks, and the list still shows', async () => {
    await readingListRepository.add(LOCAL_USER_ID, 'mock-1');
    await AsyncStorage.setItem('swipy:verified', 'not json {');
    const r = await show();
    expect(labelled(r, 'Verified')).toHaveLength(0);
    expect(texts(r)).toContain('Reading List');
  });
});

describe('useVerifiedSet', () => {
  async function harness() {
    const out = { state: undefined as never as ReturnType<typeof useVerifiedSet> };
    function H() {
      out.state = useVerifiedSet();
      return null;
    }
    await mount(<H />);
    return out;
  }

  it('is not ready until the store answers, then lists the verified ids', async () => {
    await verifiedRepository.add('a', 'Cloud');
    const out = await harness();
    expect(out.state.ready).toBe(true);
    expect([...out.state.ids]).toEqual(['a']);
  });

  it('follows new records, and is ready with an empty set when the store cannot be read', async () => {
    await AsyncStorage.setItem('swipy:verified', '7');
    const out = await harness();
    expect(out.state.ready).toBe(true);
    expect(out.state.ids.size).toBe(0);
    await AsyncStorage.clear();
    await act(async () => {
      await verifiedRepository.add('b', 'Cloud');
    });
    await act(async () => {});
    expect([...out.state.ids]).toEqual(['b']);
  });

  it('keeps the newest answer when an older read finishes late', async () => {
    const pending: Array<(ids: string[]) => void> = [];
    let notify!: () => void;
    const repo = {
      list: () => new Promise<Array<{ article_id: string; verified_at: string; topic: string }>>((resolve) => pending.push((ids) => resolve(ids.map((article_id) => ({ article_id, verified_at: 'x', topic: 'Cloud' }))))),
      isVerified: async () => false,
      add: jest.fn(),
      subscribe: (listener: () => void) => {
        notify = listener;
        return () => {};
      },
    };
    const out = { state: undefined as never as ReturnType<typeof useVerifiedSet> };
    function H() {
      out.state = useVerifiedSet(repo as never);
      return null;
    }
    await mount(<H />); // read 1 is pending
    await act(async () => notify()); // read 2 starts
    await act(async () => pending[1](['new'])); // the newer read answers first
    await act(async () => pending[0](['old'])); // the older one answers late
    expect([...out.state.ids]).toEqual(['new']);
  });

  it('stops listening when the screen goes away', async () => {
    const off = jest.fn();
    const repo = { list: async () => [], isVerified: async () => false, add: jest.fn(), subscribe: () => off };
    function H() {
      useVerifiedSet(repo as never);
      return null;
    }
    const r = await mount(<H />);
    expect(off).not.toHaveBeenCalled();
    await act(async () => r.unmount());
    expect(off).toHaveBeenCalledTimes(1);
  });
});
