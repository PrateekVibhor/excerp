import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { bottomClear } from '../../theme';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act } from 'react-test-renderer';
import { byLabel, mount, text, texts, unmountAll } from '../readers/testing';
import { CourseHomeScreen } from './CourseHomeScreen';
import { concept, fakeCourses, ok, ready, rise } from './testing';

const mockRouter = { back: jest.fn(), canGoBack: jest.fn(() => true), replace: jest.fn(), push: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));

const metrics = { frame: { x: 0, y: 0, width: 375, height: 667 }, insets: { top: 20, left: 0, right: 0, bottom: 0 } };
function open(home = ready(), api = fakeCourses(), openLink = jest.fn(async () => true)) {
  return mount(<SafeAreaProvider initialMetrics={metrics}><CourseHomeScreen courseId="c1" home={home} api={api} openLink={openLink} /></SafeAreaProvider>).then((r) => ({ r, api, openLink }));
}
const row = (r: Awaited<ReturnType<typeof open>>['r'], name: string) => byLabel(r, name)[0]!;
const header = (n: number, name: string, band: string) => `${name}, ${band}, ${n} of 3`;

beforeEach(() => jest.clearAllMocks());

afterEach(unmountAll);

describe('CourseHomeScreen', () => {
  it('marks a thin list with what it was built from, and says nothing otherwise', async () => {
    const thin = await open(ready({ evidence: { thin: true, similarPostings: 3, ownPosting: true } }));
    expect(text(thin.r)).toContain('Built from your posting and 3 similar postings');
    expect(text(thin.r)).toMatch(/thin evidence/i);
    const normal = await open(ready({ evidence: { thin: false, similarPostings: 9, ownPosting: false } }));
    expect(text(normal.r)).not.toMatch(/Built from|thin evidence/i);
  });

  it('names the role, with the industry and the number of concepts', async () => {
    const { r } = await open();
    const t = text(r);
    expect(t).toContain('LIST COURSE');
    expect(t).toContain('Data engineer');
    expect(t).toContain('Healthcare · 3 concepts');
  });

  it('with no industry the line is just the number of concepts', async () => {
    const { r } = await open(ready({ industry: null, industryLabel: null }));
    expect(text(r)).toContain('3 concepts');
    expect(text(r)).not.toContain('Healthcare');
  });

  it('shows the coverage meter, then the concepts in learning order, numbered, each with its rating', async () => {
    const { r } = await open();
    const t = texts(r);
    expect(t).toEqual(expect.arrayContaining(['COVERAGE', 'IN LEARNING ORDER']));
    const order = ['01', 'Concept 1', '02', 'Concept 2', '03', 'Concept 3'].map((x) => t.indexOf(x));
    expect(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1]!))).toBe(true);
    expect(byLabel(r, header(1, 'Concept 1', 'strong'))).toHaveLength(1);
    expect(byLabel(r, header(2, 'Concept 2', 'thin'))).toHaveLength(1);
    expect(byLabel(r, header(3, 'Concept 3', 'missing'))).toHaveLength(1);
    expect(r.root.findAll((n) => n.props.accessibilityLabel === 'Coverage: thin').length).toBeGreaterThan(0);
  });

  it('the first concept starts open; tapping a row opens it and tapping again closes it', async () => {
    const { r } = await open();
    expect(text(r)).toContain('Library 1');
    expect(text(r)).not.toContain('FHIR overview');
    await act(async () => { row(r, header(2, 'Concept 2', 'thin')).props.onPress(); });
    expect(text(r)).toContain('FHIR overview');
    expect(row(r, header(2, 'Concept 2', 'thin')).props.accessibilityState).toMatchObject({ expanded: true });
    await act(async () => { row(r, header(2, 'Concept 2', 'thin')).props.onPress(); });
    expect(text(r)).not.toContain('FHIR overview');
  });

  it('a library source is marked as vetted with its host; a web link is plain and says web', async () => {
    const { r } = await open();
    expect(text(r)).toContain('Library · mode.com');
    expect(text(r)).toContain('web');
    expect(byLabel(r, 'Library 1, library source')).toHaveLength(1);
    expect(byLabel(r, 'Web 1, web link, not reviewed')).toHaveLength(1);
  });

  it('opening a resource opens its link', async () => {
    const { r, openLink } = await open();
    await act(async () => { await byLabel(r, 'Library 1, library source')[0]!.props.onPress(); });
    expect(openLink).toHaveBeenCalledWith('https://mode.com/1');
  });

  it('a thin or missing concept explains its rating when open', async () => {
    const { r } = await open();
    await act(async () => { row(r, header(2, 'Concept 2', 'thin')).props.onPress(); });
    await act(async () => { row(r, header(3, 'Concept 3', 'missing')).props.onPress(); });
    expect(text(r)).toContain('Thin means one library source so far.');
    expect(text(r)).toContain("No library source yet. We'll let you know on this screen when one is added.");
  });

  it('a concept with no links at all still opens, with just the note', async () => {
    const { r } = await open(ready({ coverage: { total: 1, strong: 0, thin: 0, missing: 1 }, concepts: [concept(1, { band: 'missing', resources: [] })] }));
    expect(text(r)).toContain("No library source yet");
  });

  it('shows what is new when a rating has gone up, and not otherwise', async () => {
    const api = fakeCourses({ changes: jest.fn(async () => ok(rise)) });
    const { r } = await open(ready({ hasUpdates: true, seenVersion: 2 }), api);
    expect(api.changes).toHaveBeenCalledWith('c1', 2);
    const t = text(r);
    expect(t).toContain("WHAT'S NEW SINCE TUESDAY");
    expect(t).toContain('Concept 2');
    expect(t).toContain('went from missing to thin');
    expect(t).toContain('It now has 1 vetted source.');
    const quiet = fakeCourses();
    const { r: r2 } = await open(ready({ hasUpdates: false }), quiet);
    expect(quiet.changes).not.toHaveBeenCalled();
    expect(text(r2)).not.toContain("WHAT'S NEW");
  });

  it('dismissing what is new hides it and marks the changes seen', async () => {
    const api = fakeCourses({ changes: jest.fn(async () => ok(rise)) });
    const { r } = await open(ready({ hasUpdates: true }), api);
    await act(async () => { await byLabel(r, "Dismiss what's new")[0]!.props.onPress(); });
    expect(api.seen).toHaveBeenCalledWith('c1', 3);
    expect(text(r)).not.toContain("WHAT'S NEW");
  });

  it('tells whoever is listening when the reader has seen what is new', async () => {
    const onSeen = jest.fn();
    const api = fakeCourses({ changes: jest.fn(async () => ok(rise)) });
    const r = await mount(<SafeAreaProvider initialMetrics={metrics}><CourseHomeScreen courseId="c1" home={ready({ hasUpdates: true })} api={api} onSeen={onSeen} /></SafeAreaProvider>);
    await act(async () => { await byLabel(r, "Dismiss what's new")[0]!.props.onPress(); });
    expect(onSeen).toHaveBeenCalledTimes(1);
  });

  it('news that is not a rise is not shown even when there are updates', async () => {
    const api = fakeCourses({ changes: jest.fn(async () => ok({ currentVersion: 2, changes: [{ ...rise.changes[0]!, kind: 'other', summary: 'x' }] })) });
    const { r } = await open(ready({ hasUpdates: true }), api);
    expect(text(r)).not.toContain("WHAT'S NEW");
  });

  it('once the meter scrolls away a compact copy sits in the header', async () => {
    const { r } = await open(ready({ coverage: { total: 14, strong: 8, thin: 4, missing: 2 } }));
    expect(text(r)).not.toContain('8·4·2');
    await act(async () => { r.root.findByType(ScrollView).props.onScroll({ nativeEvent: { contentOffset: { y: 400 } } }); });
    expect(text(r)).toContain('8·4·2');
    await act(async () => { r.root.findByType(ScrollView).props.onScroll({ nativeEvent: { contentOffset: { y: 0 } } }); });
    expect(text(r)).not.toContain('8·4·2');
  });

  it('Back leaves the screen', async () => {
    const { r } = await open();
    await act(async () => { byLabel(r, 'Back')[0]!.props.onPress(); });
    expect(mockRouter.back).toHaveBeenCalled();
  });

  describe('inside the Skills list tab', () => {
    const chrome = (calls: string[] = []) => ({
      title: 'Treasury systems role',
      left: <Pressable accessibilityRole="button" accessibilityLabel="Open lists" onPress={() => calls.push('menu')}><Text>☰</Text></Pressable>,
      right: <Pressable accessibilityRole="button" accessibilityLabel="List options" onPress={() => calls.push('more')}><Text>…</Text></Pressable>,
    });
    const openTab = (extra: Record<string, unknown> = {}, calls: string[] = []) =>
      mount(<SafeAreaProvider initialMetrics={metrics}><CourseHomeScreen courseId="c1" home={ready()} api={fakeCourses()} chrome={chrome(calls)} {...extra} /></SafeAreaProvider>);

    it('has the tab\'s own buttons and title in place of Back', async () => {
      const calls: string[] = [];
      const r = await openTab({}, calls);
      expect(byLabel(r, 'Back')).toHaveLength(0);
      expect(text(r)).toContain('Treasury systems role');
      await act(async () => { byLabel(r, 'Open lists')[0]!.props.onPress(); byLabel(r, 'List options')[0]!.props.onPress(); });
      expect(calls).toEqual(['menu', 'more']);
    });

    it('says when the list was last checked for new sources, and when a check is under way', async () => {
      const recent = new Date(Date.now() - 5 * 60_000).toISOString();
      expect(text(await openTab({ checkedAt: recent }))).toContain('Checked 5 min ago');
      expect(text(await openTab({ checkedAt: null }))).toContain('Not checked yet');
      expect(text(await openTab({ checking: true, checkedAt: recent }))).toContain('Checking for new sources');
      expect(text(await openTab({ checking: true, checkedAt: recent }))).not.toContain('Checked 5 min ago');
    });

    it('shows no checked line outside the tab (the stand-alone screen is as it was)', async () => {
      const { r } = await open();
      expect(text(r)).not.toContain('Not checked yet');
    });
  });

  it('the last concept can scroll fully clear of the floating tab bar: the shared room under the bar is left below the list', async () => {
    const { r } = await open();
    expect(StyleSheet.flatten(r.root.findByType(ScrollView).props.contentContainerStyle).paddingBottom).toBe(0 + bottomClear);
  });
});
