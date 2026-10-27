import { act } from 'react-test-renderer';
import type { AiConsentStore } from '../../data/aiConsent';
import { byLabel, mount, text, unmountAll } from '../readers/testing';
import { WithdrawConsentRow } from './WithdrawConsentRow';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('expo-router', () => ({ useFocusEffect: (cb: () => void) => require('react').useEffect(cb, [cb]) }));

afterEach(unmountAll);

/** A device-only agreement stand-in. */
const store = (agreed: boolean) => {
  let given = agreed;
  return { hasAgreed: jest.fn(async () => given), agree: jest.fn(async () => void (given = true)), withdraw: jest.fn(async () => void (given = false)) } satisfies AiConsentStore;
};
const press = (r: Awaited<ReturnType<typeof mount>>, label: string) => act(async () => { byLabel(r, label)[0]!.props.onPress(); });

describe('WithdrawConsentRow', () => {
  it('shows nothing until the reader has agreed to the skills-list notice', async () => {
    const r = await mount(<WithdrawConsentRow store={store(false)} />);
    expect(byLabel(r, 'Withdraw agreement')).toHaveLength(0);
    expect(text(r)).toBe('');
  });

  it('after they have agreed it offers to withdraw, and says what that does', async () => {
    const r = await mount(<WithdrawConsentRow store={store(true)} />);
    expect(byLabel(r, 'Withdraw agreement')).toHaveLength(1);
    expect(text(r)).toContain('Skills list: outside services');
  });

  it('asks first; Cancel keeps the agreement', async () => {
    const s = store(true);
    const r = await mount(<WithdrawConsentRow store={s} />);
    await press(r, 'Withdraw agreement');
    expect(text(r)).toContain('Withdraw your agreement?');
    expect(text(r)).toMatch(/ask again before your next skills list is built/i);
    await press(r, 'Cancel');
    expect(s.withdraw).not.toHaveBeenCalled();
    expect(byLabel(r, 'Withdraw agreement')).toHaveLength(1);
  });

  it('confirming clears the stored agreement and the row goes away, so the next Build list asks again', async () => {
    const s = store(true);
    const r = await mount(<WithdrawConsentRow store={s} />);
    await press(r, 'Withdraw agreement');
    await press(r, 'Withdraw');
    expect(s.withdraw).toHaveBeenCalledTimes(1);
    expect(await s.hasAgreed()).toBe(false);
    expect(byLabel(r, 'Withdraw agreement')).toHaveLength(0);
  });

  it('with no store (mock data) it shows nothing and does not crash', async () => {
    const r = await mount(<WithdrawConsentRow store={null} />);
    expect(text(r)).toBe('');
  });
});
