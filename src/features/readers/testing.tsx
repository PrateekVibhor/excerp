// Shared helpers for the tests of the screens that talk to other readers: a stand-in for the server's social routes and a few finders.
import { Switch, Text } from 'react-native';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { createInboxStore } from '../../data/inboxStore';
import type { BlockEntry, ConversationView, Inbox, MessageView, MessagingSettings, ReaderCard, ReaderEntry, SocialApi, SocialResult } from '../../data/socialApi';

export const ok = <T,>(value: T): SocialResult<T> => ({ kind: 'ok', value });
export const refused = (status: number, code: string): SocialResult<never> => ({ kind: 'refused', status, code });

export const OFF: MessagingSettings = { discoverable: false, accepts_messages: false, adult_confirmed: false, terms_accepted: false };

export const reader = (n: number, over: Partial<ReaderEntry> = {}): ReaderEntry => ({
  public_id: `00000000-0000-4000-8000-00000000000${n}`, display_name: `Reader ${n}`, industry: 'Software', interests: ['Cloud'], shared_interests: 1, action: 'saved', can_message: true, ...over,
});
export const card = (n: number, over: Partial<ReaderCard> = {}): ReaderCard => ({
  public_id: `00000000-0000-4000-8000-00000000000${n}`, display_name: `Reader ${n}`, industry: 'Software', interests: ['Cloud', 'Agents'], verified_count: 2, can_message: true, ...over,
});
export const message = (n: number, over: Partial<MessageView> = {}): MessageView => ({
  id: `00000000-0000-4000-8000-00000000010${n}`, from: 'them', subject: `Subject ${n}`, body: `Body of message ${n}.`, created_at: '2026-10-10T12:00:00.000Z', read: false, ...over,
});
export const conversation = (n: number, over: Partial<ConversationView> = {}): ConversationView => ({
  id: `00000000-0000-4000-8000-00000000020${n}`, state: 'open', role: 'recipient',
  other: { public_id: `00000000-0000-4000-8000-00000000000${n}`, display_name: `Reader ${n}`, industry: 'Software', interests: ['Cloud'], deleted: false },
  article_id: null, created_at: '2026-10-10T12:00:00.000Z', last_message_at: '2026-10-10T12:00:00.000Z', unread: 0, last_message: message(n), ...over,
});
export const emptyInbox = (over: Partial<Inbox> = {}): Inbox => ({ cursor: 0, unread: 0, requests: [], conversations: [], sent: [], ...over });

/** A server stand-in whose every call is a jest mock with a sensible default answer; override any of them. */
export function fakeSocial(over: Partial<{ [K in keyof SocialApi]: jest.Mock }> = {}): SocialApi & { [K in keyof SocialApi]: jest.Mock } {
  const done = () => jest.fn(async () => ok(null));
  return {
    getSettings: jest.fn(async () => ok(OFF)),
    putSettings: jest.fn(async () => ok(OFF)),
    readers: jest.fn(async () => ok({ count: 0, readers: [] })),
    card: jest.fn(async () => ok(card(1))),
    blocks: jest.fn(async () => ok([] as BlockEntry[])),
    block: done(), unblock: done(), report: done(), send: done(), accept: done(), decline: done(), markRead: done(), hide: done(),
    inbox: jest.fn(async () => ok(emptyInbox())),
    thread: jest.fn(async () => ok({ ...conversation(1), messages: [message(1)] })),
    ...over,
  } as SocialApi & { [K in keyof SocialApi]: jest.Mock };
}

/** Every renderer `mount` made and `unmountAll` has not yet removed, so a test file can leave nothing running (timers, polls) behind it. */
const mounted = new Set<ReturnType<typeof create>>();
export async function mount(node: React.ReactElement) {
  let r!: ReturnType<typeof create>;
  await act(async () => { r = create(node); });
  await act(async () => {});
  mounted.add(r);
  return r;
}
/** Removes everything `mount` made: use in `afterEach`, so a screen that polls or times a message does not run on after its test. */
export async function unmountAll() {
  const all = [...mounted];
  mounted.clear();
  await act(async () => { for (const r of all) { try { r.unmount(); } catch { /* already gone */ } } });
}
export const texts = (r: ReturnType<typeof create>) => r.root.findAllByType(Text).map((t) => [t.props.children].flat().join(''));
export const text = (r: ReturnType<typeof create>) => texts(r).join(' | ');
export const byLabel = (r: ReturnType<typeof create>, label: string) => r.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === label && (typeof n.props.onPress === 'function' || typeof n.props.onValueChange === 'function'));
export const press = (r: ReturnType<typeof create>, label: string) => act(async () => { await byLabel(r, label)[0].props.onPress(); });
export const toggle = (r: ReturnType<typeof create>, label: string, value: boolean) => act(async () => { await r.root.findAllByType(Switch).find((s) => s.props.accessibilityLabel === label)!.props.onValueChange(value); });
export const switchOf = (r: ReturnType<typeof create>, label: string) => r.root.findAllByType(Switch).find((s) => s.props.accessibilityLabel === label)!;

/** A real inbox store over a stand-in server, already loaded with this inbox. */
export async function loadedStore(inbox: Inbox) {
  const store = createInboxStore({ inbox: jest.fn(async () => ok(inbox)) });
  await store.refresh();
  return store;
}
