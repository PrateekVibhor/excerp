import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { StyleSheet, TextInput } from 'react-native';
import type { ConversationView, MessageView, Thread } from '../../data/socialApi';
import { byLabel, conversation, fakeSocial, message, ok, refused, text } from '../readers/testing';
import { ConversationScreen } from './ConversationScreen';

let mockParams: Record<string, string | undefined> = {};
const mockRouter = { back: jest.fn(), canGoBack: jest.fn(), replace: jest.fn(), push: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useLocalSearchParams: () => mockParams }));
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../../data', () => ({ inboxStore: null }));

const metrics = { frame: { x: 0, y: 0, width: 375, height: 667 }, insets: { top: 20, left: 0, right: 0, bottom: 0 } };
const NOW = new Date('2026-10-10T15:00:00.000Z');
const opened: Array<ReturnType<typeof create>> = [];
const store = () => ({ get: jest.fn(), subscribe: jest.fn(), refresh: jest.fn(async () => {}), reset: jest.fn() });

const thread = (over: Partial<ConversationView> = {}, messages: MessageView[] = [message(1)]): Thread => ({ ...conversation(1, over), messages });

async function open(threads: Array<Thread | ReturnType<typeof refused> | { kind: 'failed' }>, socialOver: Parameters<typeof fakeSocial>[0] = {}) {
  mockParams = { id: conversation(1).id };
  const queue = [...threads];
  const social = fakeSocial({ thread: jest.fn(async () => { const next = queue.length > 1 ? queue.shift()! : queue[0]; return 'messages' in next ? ok(next) : next; }), ...socialOver });
  const s = store();
  let r!: ReturnType<typeof create>;
  await act(async () => {
    r = create(<SafeAreaProvider initialMetrics={metrics}><ConversationScreen social={social} store={s} now={NOW} /></SafeAreaProvider>);
  });
  await act(async () => {});
  opened.push(r);
  const press = (label: string) => act(async () => { await byLabel(r, label)[0].props.onPress(); });
  const pressLast = (label: string) => act(async () => { await byLabel(r, label).slice(-1)[0].props.onPress(); });
  const type = (label: string, value: string) => act(async () => { r.root.findAll((n: ReactTestInstance) => n.type === TextInput && n.props.accessibilityLabel === label)[0].props.onChangeText(value); });
  return { r, social, store: s, press, pressLast, type, text: () => text(r), has: (label: string) => byLabel(r, label).length > 0 };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRouter.canGoBack.mockReturnValue(true);
});
afterEach(() => {
  while (opened.length) act(() => opened.pop()!.unmount());
});

describe('ConversationScreen: a request waiting for an answer', () => {
  const request = () => thread({ state: 'request', role: 'recipient' }, [message(1, { subject: 'Your take on agents', body: 'I enjoyed it.\n\nWould love to compare notes.' })]);

  it('Scenario: shows who it is from and what they wrote, with Accept, Decline and Block - and says a decline is silent', async () => {
    const s = await open([request()]);
    for (const t of ['Reader 1', 'Your take on agents', 'I enjoyed it.', 'Would love to compare notes.', "If you decline, they won't be told."]) expect(s.text()).toContain(t);
    for (const b of ['Accept', 'Decline', 'Block']) expect(s.has(b)).toBe(true);
    expect(s.has('Reply')).toBe(false); // not until it is accepted
  });

  it('opening it marks what was received as read, and tells the shared inbox', async () => {
    const s = await open([request()]);
    expect(s.social.markRead).toHaveBeenCalledWith(message(1).id);
    expect(s.store.refresh).toHaveBeenCalled();
  });

  it('what was already read is not marked again', async () => {
    const s = await open([thread({ state: 'request' }, [message(1, { read: true })])]);
    expect(s.social.markRead).not.toHaveBeenCalled();
  });

  it('Scenario: Accept - the request becomes a conversation the reader can reply to', async () => {
    const s = await open([request(), thread({ state: 'open', role: 'recipient' }, [message(1)])]);
    await s.press('Accept');
    expect(s.social.accept).toHaveBeenCalledWith(conversation(1).id);
    expect(s.has('Accept')).toBe(false);
    expect(s.has('Reply')).toBe(true);
    expect(s.text()).toContain('Request accepted');
  });

  it('Scenario: Decline asks first; confirming declines and goes back, cancelling does nothing', async () => {
    const s = await open([request()]);
    await s.press('Decline');
    expect(s.text()).toContain('Decline this request?');
    await s.press('Cancel');
    expect(s.social.decline).not.toHaveBeenCalled();
    await s.press('Decline');
    await s.pressLast('Decline');
    expect(s.social.decline).toHaveBeenCalledWith(conversation(1).id);
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it('an Accept that fails says why and stays a request', async () => {
    const s = await open([request()], { accept: jest.fn(async () => refused(409, 'expired')) });
    await s.press('Accept');
    expect(s.text()).toContain('This request has expired.');
    expect(s.has('Accept')).toBe(true);
  });

  it('Scenario: Block - asks first, then blocks and goes back', async () => {
    const s = await open([request()]);
    await s.press('Block');
    expect(s.text()).toContain('Block Reader 1?');
    expect(s.social.block).not.toHaveBeenCalled();
    await s.pressLast('Block');
    expect(s.social.block).toHaveBeenCalledWith(conversation(1).other.public_id);
    expect(mockRouter.back).toHaveBeenCalled();
  });
});

describe('ConversationScreen: an open conversation', () => {
  const open_ = () => thread({ state: 'open', role: 'recipient' }, [message(1, { from: 'them', body: 'Hello there.', read: true }), message(2, { from: 'me', subject: '', body: 'Hi back.' })]);

  it('shows every message, who wrote it, and a Reply button; a reply is sent into this conversation', async () => {
    const s = await open([open_()]);
    expect(s.text()).toContain('Hello there.');
    expect(s.text()).toContain('Hi back.');
    expect(s.text()).toMatch(/You · /);
    expect(s.text()).toMatch(/Reader · /);
    await s.press('Reply');
    await s.type('Message', 'Sounds good.');
    await s.press('Send');
    expect(s.social.send).toHaveBeenCalledWith({ conversationId: conversation(1).id, subject: '', body: 'Sounds good.' });
    expect(s.text()).toContain('Sent to Reader 1');
  });

  it('the reply starts with "Re:" in front of the last subject', async () => {
    const s = await open([thread({ state: 'open' }, [message(1, { subject: 'Your take', read: true })])]);
    await s.press('Reply');
    expect(s.r.root.findAll((n: ReactTestInstance) => n.type === TextInput && n.props.accessibilityLabel === 'Subject')[0].props.value).toBe('Re: Your take');
  });

  it('Scenario: Hide - removes that message from this reader\'s view, and says nothing to the other person', async () => {
    const s = await open([open_(), thread({ state: 'open' }, [message(2, { from: 'me', body: 'Hi back.' })])]);
    await s.press('Hide this message');
    expect(s.social.hide).toHaveBeenCalledWith(message(1).id);
    expect(s.text()).not.toContain('Hello there.');
    expect(s.text()).toContain('Hi back.');
  });

  it('Scenario: Report a message from the other person - reasons, a note, and the message id is what is sent', async () => {
    const s = await open([open_()]);
    expect(byLabel(s.r, 'Report this message')).toHaveLength(1); // one message from them, one Report
    await s.press('Report this message');
    await s.press('Scam or deception');
    await s.type('Add a note (optional)', 'A sales pitch');
    await s.press('Send report');
    expect(s.social.report).toHaveBeenCalledWith({ messageId: message(1).id, reason: 'scam', note: 'A sales pitch', alsoBlock: true });
    expect(mockRouter.back).toHaveBeenCalled(); // blocked as well, so out of the conversation
  });

  it('your own messages have no Report', async () => {
    const s = await open([thread({ state: 'open' }, [message(2, { from: 'me' })])]);
    expect(s.has('Report this message')).toBe(false);
    expect(s.has('Hide this message')).toBe(true);
  });
});

describe('ConversationScreen: a request I sent', () => {
  it('Scenario: says it is waiting, offers no Accept or Reply, and never mentions a decline', async () => {
    const s = await open([thread({ state: 'pending', role: 'initiator' }, [message(1, { from: 'me' })])]);
    expect(s.text()).toContain('Waiting for a reply.');
    for (const b of ['Accept', 'Decline', 'Reply', 'Block']) expect(s.has(b)).toBe(false);
    expect(s.text().toLowerCase()).not.toContain('declin');
  });
  it('an expired one says so', async () => {
    const s = await open([thread({ state: 'expired', role: 'initiator' }, [message(1, { from: 'me' })])]);
    expect(s.text()).toContain('This request has expired.');
  });
});

describe('ConversationScreen: the other person is gone, or the page is not there', () => {
  it('Scenario: a deleted account is labelled, its profile cannot be opened, and there is no reply', async () => {
    const gone = { public_id: null, display_name: 'Deleted account', industry: null, interests: [], deleted: true };
    const s = await open([thread({ state: 'open', other: gone }, [message(1, { read: true })])]);
    expect(s.text()).toContain('Deleted account');
    expect(s.text()).toContain("can't reply");
    expect(s.has('Reply')).toBe(false);
    expect(byLabel(s.r, "Open Deleted account's profile")).toHaveLength(0);
  });

  it('the sender\'s card opens their profile', async () => {
    const s = await open([thread({ state: 'open' }, [message(1, { read: true })])]);
    await s.press("Open Reader 1's profile");
    expect(mockRouter.push).toHaveBeenCalledWith('/reader/00000000-0000-4000-8000-000000000001');
  });

  it('a conversation that is not there, or cannot be loaded, says so in words', async () => {
    expect((await open([refused(404, 'not found')])).text()).toContain('Conversation not found');
    expect((await open([{ kind: 'failed' }])).text()).toContain("Couldn't open it");
  });
});

describe('ConversationScreen: room under the last message for the floating Reply bar', () => {
  const GAP = 18; // message.gap
  const withInset = (bottom: number) => ({ ...metrics, insets: { ...metrics.insets, bottom } });
  async function show(t: Thread, bottom: number) {
    mockParams = { id: conversation(1).id };
    const social = fakeSocial({ thread: jest.fn(async () => ok(t)) });
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(<SafeAreaProvider initialMetrics={withInset(bottom)}><ConversationScreen social={social} store={store()} now={NOW} /></SafeAreaProvider>);
    });
    await act(async () => {});
    opened.push(r);
    const bar = () => r.root.findAll((n: ReactTestInstance) => n.props.pointerEvents === 'box-none' && typeof n.props.onLayout === 'function')[0];
    const bottomPadding = () => {
      const list = r.root.findAll((n: ReactTestInstance) => n.props.contentContainerStyle !== undefined)[0]!;
      return StyleSheet.flatten(list.props.contentContainerStyle).paddingBottom as number;
    };
    // The bar reports its real height (button, hint and the bottom inset, which sit inside it) when it is laid out.
    const layoutBar = (height: number) => act(async () => bar().props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 375, height } } }));
    return { r, bar, bottomPadding, layoutBar };
  }
  const open_ = () => thread({ state: 'open', role: 'recipient' }, [message(1, { from: 'them', read: true }), message(2, { from: 'me', subject: '' })]);

  it('clears a bar taller than the old fixed number, so the newest message and its Hide and Report links scroll fully above it', async () => {
    const s = await show(open_(), 34);
    await s.layoutBar(250); // a tall bar: large text, a wrapped hint
    expect(s.bottomPadding()).toBeGreaterThanOrEqual(250 + GAP);
  });

  it('follows the bar when its height changes (text size changes, the phone turns)', async () => {
    const s = await show(open_(), 34);
    await s.layoutBar(200);
    const small = s.bottomPadding();
    await s.layoutBar(320);
    expect(s.bottomPadding()).toBeGreaterThanOrEqual(320 + GAP);
    expect(s.bottomPadding()).toBeGreaterThan(small);
  });

  it('is never less than before for a normal bar, with or without a home indicator', async () => {
    for (const inset of [0, 34]) {
      const s = await show(open_(), inset);
      expect(s.bottomPadding()).toBe(inset + 170); // until the bar has been measured
      await s.layoutBar(118 + inset);
      expect(s.bottomPadding()).toBeGreaterThanOrEqual(Math.max(inset + 170, 118 + inset + GAP));
    }
  });

  it('keeps the old room when there is no Reply bar (a request, or a deleted account)', async () => {
    const s = await show(thread({ state: 'request', role: 'recipient' }), 34);
    expect(s.bar()).toBeUndefined();
    expect(s.bottomPadding()).toBe(34 + 170);
  });

  it('the Reply button still opens the compose sheet', async () => {
    const s = await show(open_(), 34);
    const reply = byLabel(s.r, 'Reply')[0]!;
    await act(async () => { reply.props.onPress(); });
    expect(text(s.r)).toContain('Text only: no links.');
  });
});
