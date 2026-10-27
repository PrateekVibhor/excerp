import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act } from 'react-test-renderer';
import type { MyList } from '../../data/courseApi';
import { byLabel, mount, press, text, texts, unmountAll } from '../readers/testing';
import { ListsPanel } from './ListsPanel';

jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));

const NOW = new Date('2026-10-19T15:00:00.000Z');
const metrics = { frame: { x: 0, y: 0, width: 375, height: 667 }, insets: { top: 20, left: 0, right: 0, bottom: 0 } };
const wrap = (node: React.ReactElement) => <SafeAreaProvider initialMetrics={metrics}>{node}</SafeAreaProvider>;
const list = (id: string, over: Partial<MyList> = {}): MyList => ({
  id, role: 'business analyst', status: 'ready', mode: 'list', visibility: 'private', industry: 'fintech', industryLabel: 'Fintech', customTitle: `List ${id}`,
  createdAt: '2026-10-19T09:00:00.000Z', lastActiveAt: '2026-10-19T13:00:00.000Z', checkedAt: null, refreshing: false, coverage: { total: 10, strong: 5, thin: 3, missing: 2 }, hasUpdates: false, ...over,
});
const LISTS = [
  list('today', { lastActiveAt: '2026-10-19T13:00:00.000Z' }),
  list('yday', { lastActiveAt: '2026-10-18T12:00:00.000Z', hasUpdates: true }),
  list('week', { lastActiveAt: '2026-10-14T12:00:00.000Z', status: 'building', coverage: null }),
  list('old', { lastActiveAt: '2026-09-01T12:00:00.000Z', refreshing: true }),
];
function open(over: Partial<React.ComponentProps<typeof ListsPanel>> = {}) {
  const fns = { onClose: jest.fn(), onNew: jest.fn(), onSelect: jest.fn(), onRename: jest.fn(), onDelete: jest.fn(), onRetry: jest.fn() };
  return mount(wrap(<ListsPanel visible status="ready" lists={LISTS} activeId="today" now={NOW} timeZone="UTC" {...fns} {...over} />)).then((r) => ({ r, ...fns }));
}

afterEach(unmountAll);

describe('ListsPanel', () => {
  it('tells two lists with the same default name apart by when each was started, and says nothing extra for a named list', async () => {
    const same = { industryLabel: 'Technology and software', customTitle: null, lastActiveAt: '2026-10-19T13:00:00.000Z' };
    const { r } = await open({ lists: [list('a', { ...same, createdAt: '2026-10-19T04:55:00.000Z' }), list('b', { ...same, createdAt: '2026-10-19T03:00:00.000Z' }), list('named')] });
    const started = texts(r).filter((t) => t.startsWith('Started '));
    expect(started).toHaveLength(2);
    expect(new Set(started).size).toBe(2);
    expect(started[0]).toMatch(/^Started Oct 19, 4:55\sAM$/);
  });

  it('is hidden until opened, and then shows its title and a New list button', async () => {
    expect(text(await mount(wrap(<ListsPanel visible={false} status="ready" lists={LISTS} activeId="today" now={NOW} onClose={jest.fn()} onNew={jest.fn()} onSelect={jest.fn()} onRename={jest.fn()} onDelete={jest.fn()} onRetry={jest.fn()} />)))).not.toContain('Skills lists');
    const { r } = await open();
    expect(text(r)).toContain('Skills lists');
    expect(byLabel(r, 'New list')).toHaveLength(1);
  });

  it('groups the lists Today, Yesterday, Previous 7 days and Older, newest first as given', async () => {
    const { r } = await open();
    const t = texts(r);
    const at = (s: string) => t.indexOf(s);
    expect([at('TODAY'), at('YESTERDAY'), at('PREVIOUS 7 DAYS'), at('OLDER')].every((i, n, a) => i >= 0 && (n === 0 || i > a[n - 1]!))).toBe(true);
    expect([at('List today'), at('List yday'), at('List week'), at('List old')].every((i, n, a) => i >= 0 && (n === 0 || i > a[n - 1]!))).toBe(true);
  });

  it('each row has its title, and its status or its mini coverage, and a dot when there is new coverage', async () => {
    const { r } = await open();
    expect(text(r)).toContain('5·3·2');
    expect(text(r)).toContain('Building');
    expect(text(r)).toContain('Checking for new sources');
    const dots = r.root.findAll((n) => n.props.accessibilityLabel === 'New coverage' && typeof n.type === 'string');
    expect(dots).toHaveLength(1);
    expect(byLabel(r, 'List yday')[0]!.findAll((n) => n.props.accessibilityLabel === 'New coverage').length).toBeGreaterThan(0);
  });

  it('a list without its own name shows the composed title', async () => {
    const { r } = await open({ lists: [list('x', { customTitle: null })], activeId: null });
    expect(text(r)).toContain('Business analyst · Fintech · Oct 19');
  });

  it('marks the open list as selected', async () => {
    const { r } = await open();
    expect(byLabel(r, 'List today')[0]!.props.accessibilityState).toMatchObject({ selected: true });
    expect(byLabel(r, 'List yday')[0]!.props.accessibilityState).toMatchObject({ selected: false });
  });

  it('tapping a row opens that list', async () => {
    const { r, onSelect } = await open();
    await press(r, 'List yday');
    expect(onSelect).toHaveBeenCalledWith('yday');
  });

  it('New list starts a new one, and the close button and the backdrop close the panel', async () => {
    const { r, onNew, onClose } = await open();
    await press(r, 'New list');
    expect(onNew).toHaveBeenCalledTimes(1);
    await press(r, 'Close lists');
    await press(r, 'Close panel');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('each row has its own menu with Rename and Delete', async () => {
    const { r, onRename, onDelete } = await open();
    await press(r, 'More options for List week');
    expect(text(r)).toContain('List week');
    await press(r, 'Rename');
    expect(onRename).toHaveBeenCalledWith(expect.objectContaining({ id: 'week' }));
    await press(r, 'More options for List old');
    await press(r, 'Delete');
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'old' }));
  });

  it('says so when there are no lists yet, and when they could not be loaded, with a Retry', async () => {
    expect(text((await open({ lists: [], activeId: null })).r)).toContain('No lists yet');
    const failed = await open({ status: 'unavailable', lists: [] });
    expect(text(failed.r)).toContain("Couldn't load your lists");
    await press(failed.r, 'Retry');
    expect(failed.onRetry).toHaveBeenCalled();
    expect(byLabel((await open({ status: 'loading', lists: [] })).r, 'New list')).toHaveLength(1);
  });

  it('goes away when closed', async () => {
    const { r } = await open();
    await act(async () => { r.update(wrap(<ListsPanel visible={false} status="ready" lists={LISTS} activeId="today" now={NOW} onClose={jest.fn()} onNew={jest.fn()} onSelect={jest.fn()} onRename={jest.fn()} onDelete={jest.fn()} onRetry={jest.fn()} />)); });
    expect(text(r)).not.toContain('Skills lists');
  });
});
