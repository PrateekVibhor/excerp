import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { Switch, TextInput } from 'react-native';
import { byLabel, card, fakeSocial, ok, refused, text } from '../readers/testing';
import { ReaderProfileScreen } from './ReaderProfileScreen';

let mockParams: Record<string, string | string[] | undefined> = {};
const mockRouter = { back: jest.fn(), canGoBack: jest.fn(), replace: jest.fn(), push: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useLocalSearchParams: () => mockParams }));
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../../data', () => ({ socialApi: null }));

const metrics = { frame: { x: 0, y: 0, width: 375, height: 667 }, insets: { top: 20, left: 0, right: 0, bottom: 0 } };
const ID = '00000000-0000-4000-8000-000000000001';
const opened: Array<ReturnType<typeof create>> = [];

async function open(social: ReturnType<typeof fakeSocial> | null, params: Record<string, string> = { id: ID }) {
  mockParams = params;
  let r!: ReturnType<typeof create>;
  await act(async () => {
    r = create(<SafeAreaProvider initialMetrics={metrics}><ReaderProfileScreen social={social} /></SafeAreaProvider>);
  });
  await act(async () => {});
  opened.push(r);
  const press = (label: string) => act(async () => { await byLabel(r, label)[0].props.onPress(); });
  const type = (label: string, value: string) => act(async () => { r.root.findAll((n: ReactTestInstance) => n.type === TextInput && n.props.accessibilityLabel === label)[0].props.onChangeText(value); });
  return { r, press, type, text: () => text(r), has: (label: string) => byLabel(r, label).length > 0 };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRouter.canGoBack.mockReturnValue(true);
});
afterEach(() => {
  while (opened.length) act(() => opened.pop()!.unmount());
});

describe('ReaderProfileScreen: the profile', () => {
  it('Scenario: View another reader - their name, industry, interests and how many articles they verified', async () => {
    const social = fakeSocial({ card: jest.fn(async () => ok(card(1, { display_name: 'Maya Chen', industry: 'Software', interests: ['Agents', 'Cloud'], verified_count: 3 }))) });
    const s = await open(social);
    expect(social.card).toHaveBeenCalledWith(ID);
    for (const t of ['Maya Chen', 'Software', 'Agents', 'Cloud', '3 verified articles']) expect(s.text()).toContain(t);
    expect(s.text()).not.toContain('Reader not found');
  });

  it('says "1 verified article" for one', async () => {
    const s = await open(fakeSocial({ card: jest.fn(async () => ok(card(1, { verified_count: 1 }))) }));
    expect(s.text()).toContain('1 verified article');
    expect(s.text()).not.toContain('1 verified articles');
  });

  it('Scenario: a profile that cannot be shown says only "Reader not found", whatever the reason', async () => {
    for (const result of [refused(404, 'not found'), { kind: 'failed' as const }]) {
      const s = await open(fakeSocial({ card: jest.fn(async () => result) }));
      expect(s.text()).toContain('Reader not found');
      expect(s.has('Send message request')).toBe(false);
    }
  });

  it('with no id, or no server (mock data), there is no reader to show', async () => {
    expect((await open(fakeSocial(), {})).text()).toContain('Reader not found');
    expect((await open(null)).text()).toContain('Reader not found');
  });

  it('Scenario: a reader who is not visible themselves is invited to be, not shown anyone', async () => {
    const social = fakeSocial({ card: jest.fn(async () => refused(403, 'visibility_required')) });
    const s = await open(social);
    expect(s.has('Turn on Show me as reading')).toBe(true);
    expect(s.text()).toContain('visible to them too');
  });

  it('Back goes back, or to the feed when there is nothing to go back to', async () => {
    const s = await open(fakeSocial());
    await s.press('Back');
    expect(mockRouter.back).toHaveBeenCalled();
    mockRouter.canGoBack.mockReturnValue(false);
    await s.press('Back');
    expect(mockRouter.replace).toHaveBeenCalledWith('/feed');
  });
});

describe('ReaderProfileScreen: messaging', () => {
  it('Scenario: a reader who takes messages can be sent a request, which carries the article it came from', async () => {
    const social = fakeSocial({ card: jest.fn(async () => ok(card(1, { can_message: true }))) });
    const s = await open(social, { id: ID, article: 'art-1' });
    await s.press('Send message request');
    expect(s.text()).toContain('Message request');
    await s.type('Message', 'I liked your take.');
    await s.press('Send');
    expect(social.send).toHaveBeenCalledWith({ to: ID, subject: '', body: 'I liked your take.', articleId: 'art-1' });
    expect(s.text()).toContain('Request sent to Reader 1');
  });

  it('a request that is refused says why, in words, and stays open', async () => {
    const social = fakeSocial({ send: jest.fn(async () => refused(409, 'already_requested')) });
    const s = await open(social);
    await s.press('Send message request');
    await s.type('Message', 'Hello');
    await s.press('Send');
    expect(s.text()).toContain("You've already written to this reader.");
    expect(s.has('Send')).toBe(true);
  });

  it('a reader who does not take messages is not offered a button, and the screen says so', async () => {
    const s = await open(fakeSocial({ card: jest.fn(async () => ok(card(1, { display_name: 'Maya Chen', can_message: false }))) }));
    expect(s.has('Send message request')).toBe(false);
    expect(s.text()).toContain("Maya isn't taking messages.");
  });
});

describe('ReaderProfileScreen: block and report', () => {
  it('Scenario: Block asks first, says nobody is told, then blocks and goes back', async () => {
    const social = fakeSocial();
    const s = await open(social);
    await s.press('Block');
    expect(s.text()).toContain('Block Reader 1?');
    expect(s.text()).toContain("they won't be told");
    expect(social.block).not.toHaveBeenCalled();
    await act(async () => { await byLabel(s.r, 'Block').slice(-1)[0].props.onPress(); }); // the dialog's own button
    expect(social.block).toHaveBeenCalledWith(ID);
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it('cancelling the question blocks nobody', async () => {
    const social = fakeSocial();
    const s = await open(social);
    await s.press('Block');
    await s.press('Cancel');
    expect(social.block).not.toHaveBeenCalled();
  });

  it('a block that fails says so and stays on the screen', async () => {
    const social = fakeSocial({ block: jest.fn(async () => ({ kind: 'failed' as const })) });
    const s = await open(social);
    await s.press('Block');
    await act(async () => { await byLabel(s.r, 'Block').slice(-1)[0].props.onPress(); });
    expect(s.text()).toContain("Couldn't reach the server");
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('Scenario: Report - pick a reason, add a note, and it is sent with the article it came from', async () => {
    const social = fakeSocial();
    const s = await open(social, { id: ID, article: 'art-1' });
    await s.press('Report');
    expect(byLabel(s.r, 'Send report')[0].props.accessibilityState.disabled).toBe(true); // a reason is needed
    await s.press('Harassment or threats');
    await s.type('Add a note (optional)', 'Odd messages');
    await act(async () => { s.r.root.findAllByType(Switch).find((x) => x.props.accessibilityLabel === 'Also block them')!.props.onValueChange(false); });
    await s.press('Send report');
    expect(social.report).toHaveBeenCalledWith({ publicId: ID, reason: 'harassment', note: 'Odd messages', alsoBlock: false, articleId: 'art-1' });
    expect(s.text()).toContain('Thanks, we will review it');
    expect(mockRouter.back).not.toHaveBeenCalled(); // not blocked, so they stay
  });

  it('reporting and blocking together goes back', async () => {
    const social = fakeSocial();
    const s = await open(social);
    await s.press('Report');
    await s.press('Spam or unwanted promotion');
    await s.press('Send report'); // "also block" is on to begin with
    expect(social.report).toHaveBeenCalledWith(expect.objectContaining({ alsoBlock: true }));
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it('a report that fails says so and keeps the sheet open', async () => {
    const social = fakeSocial({ report: jest.fn(async () => refused(429, 'too many reports; try again later')) });
    const s = await open(social);
    await s.press('Report');
    await s.press('Scam or deception');
    await s.press('Send report');
    expect(s.text()).toContain("reached today's limit");
    expect(s.has('Send report')).toBe(true);
  });
});
