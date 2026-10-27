import { StyleSheet, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { ReactTestInstance } from 'react-test-renderer';
import { act, create } from 'react-test-renderer';
import { createInboxStore } from '../../data/inboxStore';
import type { ConversationView, Inbox } from '../../data/socialApi';
import { colors } from '../../theme';
import { conversation, emptyInbox, message, ok } from '../readers/testing';
import { InboxScreen } from './InboxScreen';

const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../../data', () => ({ inboxStore: null }));

// Wednesday 10 March 2027, 15:00 on the device clock: a date that is not the real "now" when the tests run.
const NOW = new Date(2027, 2, 10, 15, 0);
const at = (d: number, h: number, m: number) => new Date(2027, 2, d, h, m).toISOString();
const metrics = { frame: { x: 0, y: 0, width: 375, height: 667 }, insets: { top: 20, left: 0, right: 0, bottom: 0 } };

/** A conversation whose last message is `n`, with the given text and time. */
const c = (n: number, over: Partial<ConversationView> & { subject?: string; body?: string; time?: string; from?: 'me' | 'them' } = {}): ConversationView => {
  const { subject, body, time, from, ...rest } = over;
  const when = time ?? at(10, 9, 41);
  return conversation(n, { last_message_at: when, last_message: message(n, { subject: subject ?? `Subject ${n}`, body: body ?? `Body of ${n}.\n\nSecond paragraph.`, created_at: when, from: from ?? 'them' }), ...rest });
};

async function open(inbox: Inbox, options: { initialTab?: 'requests' | 'conversations' | 'sent'; failed?: boolean } = {}) {
  const api = { inbox: jest.fn(async () => (options.failed ? ({ kind: 'failed' } as const) : ok(inbox))) };
  const store = createInboxStore(api);
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <SafeAreaProvider initialMetrics={metrics}>
        <InboxScreen store={store} now={NOW} initialTab={options.initialTab} />
      </SafeAreaProvider>,
    );
  });
  await act(async () => {});
  const rows = () =>
    renderer.root.findAll((n: ReactTestInstance) => typeof n.props.onPress === 'function' && String(n.props.accessibilityLabel ?? '').startsWith('Open ')).filter((n, i, all) => all.findIndex((o) => o.props.accessibilityLabel === n.props.accessibilityLabel) === i);
  const texts = (node: ReactTestInstance) => node.findAllByType(Text).map((t) => [t.props.children].flat().join(''));
  const styleOf = (node: ReactTestInstance) => StyleSheet.flatten(node.props.style);
  const tab = (label: string) => renderer.root.findAll((n: ReactTestInstance) => n.props.accessibilityRole === 'tab' && String(n.props.accessibilityLabel).startsWith(label))[0];
  return { renderer, api, rows, texts, styleOf, tab, all: () => JSON.stringify(renderer.toJSON()) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRouter.canGoBack.mockReturnValue(true);
});

describe('InboxScreen: the list', () => {
  it('Scenario: Open the inbox - conversations newest first', async () => {
    const screen = await open(emptyInbox({ conversations: [c(1, { time: at(10, 8, 2) }), c(2, { time: at(10, 9, 41) }), c(3, { time: at(9, 18, 15) })] }));
    expect(screen.rows().map((r) => r.props.accessibilityLabel)).toEqual(['Open Subject 2 with Reader 2', 'Open Subject 1 with Reader 1', 'Open Subject 3 with Reader 3']);
  });

  it('shows who, their industry, the subject, a one-line preview and the time on each row', async () => {
    const screen = await open(emptyInbox({ conversations: [c(1)] }));
    const texts = screen.texts(screen.rows()[0]);
    expect(texts).toEqual(expect.arrayContaining(['Reader 1', '9:41 AM', 'Software', 'Subject 1', 'Body of 1.']));
    expect(texts).not.toContain('Second paragraph.');
    expect(texts).toContain('R1');
  });

  it('keeps subject and preview to one line', async () => {
    const screen = await open(emptyInbox({ conversations: [c(1, { subject: 'S'.repeat(300), body: 'B'.repeat(900) })] }));
    const lines = screen.rows()[0].findAllByType(Text).filter((t) => t.props.numberOfLines === 1);
    expect(lines.map((t) => [t.props.children].flat().join('')[0])).toEqual(expect.arrayContaining(['S', 'B']));
  });

  it('labels the time as Yesterday, a weekday or a date for older ones', async () => {
    const screen = await open(emptyInbox({ conversations: [c(1, { time: at(9, 18, 15) }), c(2, { time: at(7, 11, 20) }), c(3, { time: new Date(2027, 1, 5, 16, 47).toISOString() })] }));
    expect(screen.rows().flatMap((r) => screen.texts(r))).toEqual(expect.arrayContaining(['Yesterday', 'Sun', 'Feb 5']));
  });

  it('shows unread rows differently from read rows: fill, border, dot and weight', async () => {
    const screen = await open(emptyInbox({ conversations: [c(1, { unread: 1, time: at(10, 9, 41) }), c(2, { unread: 0, time: at(10, 8, 0) })] }));
    const [unread, read] = screen.rows();
    expect(unread.props.accessibilityValue).toEqual({ text: 'unread' });
    expect(read.props.accessibilityValue).toEqual({ text: 'read' });
    expect(screen.styleOf(unread)).toMatchObject({ backgroundColor: colors.inbox.unreadBg, borderColor: colors.inbox.unreadBorder });
    expect(screen.styleOf(read)).toMatchObject({ backgroundColor: colors.inbox.readBg, borderColor: colors.inbox.readBorder });
    const dots = (row: ReactTestInstance) => row.findAll((n) => screen.styleOf(n)?.backgroundColor === colors.inbox.unreadDot);
    expect(dots(unread).length).toBeGreaterThan(0);
    expect(dots(read)).toHaveLength(0);
    const font = (row: ReactTestInstance, label: string) => screen.styleOf(row.findAllByType(Text).find((t) => [t.props.children].flat().join('') === label)!).fontFamily;
    expect(font(unread, 'Reader 1')).toBe('Geist-SemiBold');
    expect(font(read, 'Reader 2')).toBe('Geist-Medium');
  });

  it('a message with no text reads "No message text", and no subject reads "No subject"', async () => {
    const screen = await open(emptyInbox({ conversations: [c(1, { body: '', subject: '' })] }));
    expect(screen.texts(screen.rows()[0])).toEqual(expect.arrayContaining(['No message text', 'No subject']));
  });

  it('a message you sent is marked "You:" in the preview', async () => {
    const screen = await open(emptyInbox({ conversations: [c(1, { from: 'me' })] }));
    expect(screen.texts(screen.rows()[0]).join('')).toContain('You: Body of 1.');
  });

  it('Scenario: a deleted account shows as "Deleted account", with no industry', async () => {
    const gone = c(1, { other: { public_id: null, display_name: 'Deleted account', industry: null, interests: [], deleted: true } });
    const screen = await open(emptyInbox({ conversations: [gone] }));
    const texts = screen.texts(screen.rows()[0]);
    expect(texts).toContain('Deleted account');
    expect(texts).not.toContain('Software');
  });

  it('pressing a row opens that conversation', async () => {
    const screen = await open(emptyInbox({ conversations: [c(1)] }));
    act(() => screen.rows()[0].props.onPress());
    expect(mockRouter.push).toHaveBeenCalledWith(`/inbox/${c(1).id}`);
  });

  it('Back goes to the Profile', async () => {
    const screen = await open(emptyInbox());
    act(() => screen.renderer.root.findByProps({ accessibilityLabel: 'Back' }).props.onPress());
    expect(mockRouter.back).toHaveBeenCalled();
  });
});

describe('InboxScreen: requests, messages and sent', () => {
  const inbox = emptyInbox({
    unread: 2,
    requests: [c(1, { state: 'request', unread: 1 })],
    conversations: [c(2, { unread: 1 })],
    sent: [c(3, { role: 'initiator', state: 'pending', from: 'me' }), c(4, { role: 'initiator', state: 'expired', from: 'me' })],
  });

  it('Scenario: three tabs, each with its own list, and the unread number on the ones that have some', async () => {
    const screen = await open(inbox, { initialTab: 'requests' });
    expect(screen.tab('Requests').props.accessibilityState).toEqual({ selected: true });
    expect(screen.tab('Requests').props.accessibilityLabel).toBe('Requests, 1 unread');
    expect(screen.tab('Messages').props.accessibilityLabel).toBe('Messages, 1 unread');
    expect(screen.tab('Sent').props.accessibilityLabel).toBe('Sent');
    expect(screen.rows().map((r) => r.props.accessibilityLabel)).toEqual(['Open Subject 1 with Reader 1']);
    await act(async () => screen.tab('Messages').props.onPress());
    expect(screen.rows().map((r) => r.props.accessibilityLabel)).toEqual(['Open Subject 2 with Reader 2']);
    await act(async () => screen.tab('Sent').props.onPress());
    expect(screen.rows()).toHaveLength(2);
  });

  it('Scenario: a request I sent says only that it is waiting, or that it expired - never that it was declined', async () => {
    const screen = await open(inbox, { initialTab: 'sent' });
    const notes = screen.rows().flatMap((r) => screen.texts(r));
    expect(notes).toEqual(expect.arrayContaining(['Waiting for a reply', 'Expired']));
    expect(screen.all().toLowerCase()).not.toContain('declin');
  });

  it('each tab has its own friendly empty state', async () => {
    const empty = await open(emptyInbox(), { initialTab: 'requests' });
    expect(empty.all()).toContain('No requests');
    await act(async () => empty.tab('Messages').props.onPress());
    expect(empty.all()).toContain('No conversations yet');
    await act(async () => empty.tab('Sent').props.onPress());
    expect(empty.all()).toContain('Nothing sent');
  });

  it('the header counts everything and the unread ones', async () => {
    const screen = await open(inbox);
    expect(screen.all()).toContain('2 UNREAD · 4 CONVERSATIONS');
    expect((await open(emptyInbox())).all()).toContain('NOTHING HERE YET');
  });

  it('when it cannot be loaded the screen says so rather than looking empty', async () => {
    const screen = await open(emptyInbox(), { failed: true });
    expect(screen.all()).toContain("Couldn't load your inbox");
  });
});

describe('InboxScreen: the pills and the tab it opens on', () => {
  const labelsOf = (screen: Awaited<ReturnType<typeof open>>) => screen.renderer.root.findAll((n: ReactTestInstance) => n.props.accessibilityRole === 'tab').map((n) => String(n.props.accessibilityLabel)).filter((l, i, all) => all.indexOf(l) === i);
  const selected = (screen: Awaited<ReturnType<typeof open>>) => screen.renderer.root.findAll((n: ReactTestInstance) => n.props.accessibilityRole === 'tab' && n.props.accessibilityState?.selected === true).map((n) => String(n.props.accessibilityLabel)).filter((l, i, all) => all.indexOf(l) === i);
  const inbox = () => emptyInbox({ requests: [c(1, { state: 'request', role: 'recipient' })], conversations: [c(2)], sent: [c(3, { state: 'pending', role: 'initiator' })] });

  it('the pills are Messages, Sent, Requests, in that order', async () => {
    expect(labelsOf(await open(emptyInbox()))).toEqual(['Messages', 'Sent', 'Requests']);
  });

  it('opened with no tab named, the Inbox is on Messages, whatever the order of the pills', async () => {
    const screen = await open(inbox());
    expect(selected(screen)).toEqual(['Messages']);
    expect(screen.rows().map((r) => r.props.accessibilityLabel)).toEqual(['Open Subject 2 with Reader 2']);
  });

  it('each pill still shows its own content, and an explicit tab still wins', async () => {
    const screen = await open(inbox());
    for (const [label, row] of [['Sent', 'Open Subject 3 with Reader 3'], ['Requests', 'Open Subject 1 with Reader 1'], ['Messages', 'Open Subject 2 with Reader 2']] as const) {
      await act(async () => { screen.tab(label).props.onPress(); });
      expect(selected(screen)).toEqual([label]);
      expect(screen.rows().map((r) => r.props.accessibilityLabel)).toEqual([row]);
    }
    expect(selected(await open(inbox(), { initialTab: 'requests' }))).toEqual(['Requests']);
  });
});
