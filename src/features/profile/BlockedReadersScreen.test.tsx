import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create } from 'react-test-renderer';
import { byLabel, fakeSocial, ok, text } from '../readers/testing';
import { BlockedReadersScreen } from './BlockedReadersScreen';

const mockRouter = { back: jest.fn(), canGoBack: jest.fn(), replace: jest.fn(), push: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../../data', () => ({ socialApi: null }));

const metrics = { frame: { x: 0, y: 0, width: 375, height: 667 }, insets: { top: 20, left: 0, right: 0, bottom: 0 } };
const blocked = (n: number) => ({ public_id: `00000000-0000-4000-8000-00000000000${n}`, display_name: `Reader ${n}`, blocked_at: '2026-10-10T12:00:00.000Z' });

async function open(social: ReturnType<typeof fakeSocial> | null) {
  let r!: ReturnType<typeof create>;
  await act(async () => { r = create(<SafeAreaProvider initialMetrics={metrics}><BlockedReadersScreen social={social} /></SafeAreaProvider>); });
  await act(async () => {});
  return r;
}

describe('BlockedReadersScreen', () => {
  it('lists the readers this reader blocked, each with Unblock', async () => {
    const r = await open(fakeSocial({ blocks: jest.fn(async () => ok([blocked(1), blocked(2)])) }));
    expect(text(r)).toContain('Blocked readers');
    expect(text(r)).toContain('Reader 1');
    expect(byLabel(r, 'Unblock Reader 2')).toHaveLength(1);
  });

  it('Scenario: Unblock - the reader leaves the list, and the server is told', async () => {
    const social = fakeSocial({ blocks: jest.fn(async () => ok([blocked(1), blocked(2)])) });
    const r = await open(social);
    await act(async () => { await byLabel(r, 'Unblock Reader 1')[0].props.onPress(); });
    expect(social.unblock).toHaveBeenCalledWith(blocked(1).public_id);
    expect(text(r)).not.toContain('Reader 1');
    expect(text(r)).toContain('Reader 2');
  });

  it('an unblock that fails keeps the reader on the list and says so', async () => {
    const social = fakeSocial({ blocks: jest.fn(async () => ok([blocked(1)])), unblock: jest.fn(async () => ({ kind: 'failed' as const })) });
    const r = await open(social);
    await act(async () => { await byLabel(r, 'Unblock Reader 1')[0].props.onPress(); });
    expect(text(r)).toContain('Reader 1');
    expect(text(r)).toContain("Couldn't reach the server");
  });

  it('says so when nobody is blocked, and when the list cannot be loaded', async () => {
    expect(text(await open(fakeSocial()))).toContain("You haven't blocked anyone.");
    expect(text(await open(fakeSocial({ blocks: jest.fn(async () => ({ kind: 'failed' as const })) })))).toContain("Couldn't load your blocked readers");
    expect(text(await open(null))).toContain("Couldn't load your blocked readers"); // mock data
  });
});
