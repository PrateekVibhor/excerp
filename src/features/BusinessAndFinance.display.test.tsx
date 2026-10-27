// How the Business and Finance publishers and tags show up in the app: tables, colours, and the card,
// the Reading List row and the article screen that display them.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create } from 'react-test-renderer';
import { useSharedValue } from 'react-native-reanimated';
import type { Article, ReadingListItem } from '../data';
import { CONTENT_TYPES, SOURCE_COMPANIES } from '../data/types';
import { colors } from '../theme';
import { ArticleDetailScreen } from './article/ArticleDetailScreen';
import { CardStack } from './feed/CardStack';
import { brandFor, monogramFor, monograms, tagFor } from './feed/cardFormat';
import { ReadingListRow } from './readingList/ReadingListRow';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(), ImpactFeedbackStyle: { Light: 'light' } }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
const mockParams = { id: 'biz-1' };
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true }),
  useLocalSearchParams: () => mockParams,
}));

const summary = Array.from({ length: 55 }, (_, i) => `word${i}`).join(' ');
const business = (id: string, source_company: Article['source_company'], content_type: Article['content_type'], url: string): Article => ({
  id,
  source_company,
  source_url: url,
  content_type,
  title: 'How companies are rethinking the operating model in the AI era',
  summary,
  published_at: '2026-09-30T00:00:00.000Z',
  fetched_at: '2026-10-04T15:00:00.000Z',
  reader_count: 120,
});
const ARTICLES = [
  business('biz-1', 'MIT Sloan Management Review', 'Venture Capital', 'https://sloanreview.mit.edu/article/why-design-thinking-needs-a-responsibility-reboot'),
  business('biz-2', 'Harvard Business Review', 'Consulting', 'https://hbr.org/product/the-mindsets-leaders-need'),
  business('biz-3', 'Andreessen Horowitz', 'Venture Capital', 'https://a16z.com/who-gets-paid-when-ai-does-the-shopping'),
  business('biz-4', 'CFA Institute', 'Finance', 'https://rpc.cfainstitute.org/blogs/enterprising-investor/2026/now-ai-can-pass-mock-exams'),
];

jest.mock('../data', () => {
  const actual = jest.requireActual('../data');
  return {
    ...actual,
    articleRepository: {
      getFeed: async () => [],
      getById: async (id: string) => (global as { __articles?: Article[] }).__articles?.find((a) => a.id === id),
    },
  };
});
beforeAll(() => {
  (global as { __articles?: Article[] }).__articles = ARTICLES;
});

// Contrast ratio between two #rrggbb colours (WCAG): 4.5 is the usual bar for text this size.
const channel = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('every publisher and tag is covered in the app\'s tables', () => {
  it('has a monogram and colours for each of the 19 publishers', () => {
    expect(SOURCE_COMPANIES).toHaveLength(19);
    for (const company of SOURCE_COMPANIES) {
      expect(monograms[company]).toBeTruthy();
      expect(monograms[company].length).toBeLessThanOrEqual(4); // fits the 42 pt monogram square
      expect(colors.brand[company].bg).toMatch(/^#[0-9a-f]{6}$/);
      expect(colors.brand[company].fg).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('has colours for each of the 7 tags', () => {
    expect(CONTENT_TYPES).toHaveLength(7);
    for (const type of CONTENT_TYPES) {
      expect(colors.tag[type].fg).toMatch(/^#[0-9a-f]{6}$/);
      expect(colors.tag[type].bg).toMatch(/^rgba\(/);
    }
  });

  it('gives the three new tags colours of their own, different from the four existing ones', () => {
    const fgs = CONTENT_TYPES.map((t) => colors.tag[t].fg);
    expect(new Set(fgs).size).toBe(fgs.length);
  });

  it('keeps each new publisher\'s monogram readable on its colour', () => {
    for (const company of SOURCE_COMPANIES.slice(7)) {
      expect(contrast(colors.brand[company].fg, colors.brand[company].bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps each tag readable on the card', () => {
    // The card is the glass surface (white at 62%) over the pale page, which looks like #fbfdfc. theme/contrast.test.ts checks each tag on its own tint as well.
    for (const type of CONTENT_TYPES) expect(contrast(colors.tag[type].fg, '#fbfdfc')).toBeGreaterThanOrEqual(4.5);
  });
});

const metrics = { frame: { x: 0, y: 0, width: 402, height: 874 }, insets: { top: 62, left: 0, right: 0, bottom: 34 } };
const texts = (r: ReturnType<typeof create>) => r.root.findAllByType(Text).map((t) => ({ text: [t.props.children].flat().join(''), lines: t.props.numberOfLines as number | undefined }));

function Stack({ articles }: { articles: Article[] }) {
  const dragX = useSharedValue(0);
  return <CardStack articles={articles} index={0} dragX={dragX} onSwipe={jest.fn()} />;
}

describe('Scenario: the tag shows as a small label next to the publisher name', () => {
  it('on the card: monogram, publisher, domain and the tag', () => {
    jest.useFakeTimers();
    let r!: ReturnType<typeof create>;
    act(() => {
      r = create(<Stack articles={[ARTICLES[2]]} />);
    });
    const all = texts(r).map((t) => t.text);
    expect(all).toEqual(expect.arrayContaining(['a16z', 'Andreessen Horowitz', 'a16z.com', 'Venture Capital']));
    jest.useRealTimers();
  });

  it('keeps the long names to one line, so they cannot push the tag off the card', () => {
    jest.useFakeTimers();
    for (const article of [ARTICLES[0], ARTICLES[1]]) {
      let r!: ReturnType<typeof create>;
      act(() => {
        r = create(<Stack articles={[article]} />);
      });
      const name = texts(r).find((t) => t.text === article.source_company)!;
      expect(name.lines).toBe(1);
      expect(texts(r).map((t) => t.text)).toContain(article.content_type);
    }
    jest.useRealTimers();
  });

  it('in the Reading List: publisher, then the tag', () => {
    const entry = { item: { id: 'i', user_id: 'u', article_id: 'biz-4', saved_at: '2026-10-04T10:00:00.000Z' } as ReadingListItem, article: ARTICLES[3] };
    let r!: ReturnType<typeof create>;
    act(() => {
      r = create(<ReadingListRow entry={entry} onOpen={jest.fn()} onRemove={jest.fn()} />);
    });
    const all = texts(r);
    const company = all.find((t) => t.text === 'CFA Institute')!;
    expect(company.lines).toBe(1);
    expect(all.map((t) => t.text)).toEqual(expect.arrayContaining(['CFA', 'Finance']));
    expect(all.findIndex((t) => t.text === 'CFA Institute')).toBeLessThan(all.findIndex((t) => t.text === 'Finance'));
  });

  it('on the article screen: publisher, domain and tag in the header', async () => {
    await AsyncStorage.clear();
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(
        <SafeAreaProvider initialMetrics={metrics}>
          <ArticleDetailScreen />
        </SafeAreaProvider>,
      );
    });
    await act(async () => {});
    const all = texts(r);
    expect(all.map((t) => t.text)).toEqual(expect.arrayContaining(['SMR', 'MIT Sloan Management Review', 'mit.edu', 'Venture Capital']));
    expect(all.find((t) => t.text === 'MIT Sloan Management Review')!.lines).toBe(1);
  });
});

// An older app meets a publisher or tag a newer server sends: it must still show the article.
describe('an unknown publisher or tag', () => {
  const stranger = { ...ARTICLES[0], id: 'biz-9', source_company: 'Zeta Capital', content_type: 'Climate' } as unknown as Article;

  it('falls back to neutral colors, the first letter and the tag text', () => {
    expect(monogramFor('Zeta Capital')).toBe('Z');
    expect(monogramFor('')).toBe('?');
    expect(brandFor('Zeta Capital').bg).toBeTruthy();
    expect(tagFor('Climate').fg).toBeTruthy();
    expect(monogramFor('McKinsey')).toBe(monograms.McKinsey); // known ones are unchanged
    expect(brandFor('McKinsey')).toBe(colors.brand.McKinsey);
    expect(tagFor('Finance')).toBe(colors.tag.Finance);
  });

  it('renders on the card and the Reading List row without throwing', () => {
    jest.useFakeTimers();
    let r!: ReturnType<typeof create>;
    act(() => {
      r = create(<Stack articles={[stranger]} />);
    });
    expect(texts(r).map((t) => t.text)).toEqual(expect.arrayContaining(['Z', 'Zeta Capital', 'Climate']));
    jest.useRealTimers();
    const entry = { item: { id: 'i', user_id: 'u', article_id: 'biz-9', saved_at: '2026-10-04T10:00:00.000Z' } as ReadingListItem, article: stranger };
    act(() => {
      r = create(<ReadingListRow entry={entry} onOpen={jest.fn()} onRemove={jest.fn()} />);
    });
    expect(texts(r).map((t) => t.text)).toEqual(expect.arrayContaining(['Zeta Capital', 'Climate']));
  });

  it('renders on the article screen', async () => {
    (global as { __articles?: Article[] }).__articles = [{ ...stranger, id: 'biz-1' }];
    await AsyncStorage.clear();
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(
        <SafeAreaProvider initialMetrics={metrics}>
          <ArticleDetailScreen />
        </SafeAreaProvider>,
      );
    });
    await act(async () => {});
    expect(texts(r).map((t) => t.text)).toEqual(expect.arrayContaining(['Z', 'Zeta Capital', 'Climate']));
    (global as { __articles?: Article[] }).__articles = ARTICLES;
  });
});
