import { act, create } from 'react-test-renderer';
import type { Profile } from '../../data';
import { useProfile, type ProfileSource } from './useProfile';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const maya: Profile = { display_name: 'Maya', industry: 'Media', interests: ['Safety'] };
const sam: Profile = { display_name: 'Sam', industry: 'Finance', interests: ['Cloud'] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function mount(source: ProfileSource) {
  const result = {} as ReturnType<typeof useProfile>;
  function Harness() {
    Object.assign(result, useProfile(source));
    return null;
  }
  await act(async () => {
    create(<Harness />);
  });
  return result;
}

describe('useProfile', () => {
  it('loads null when nothing is saved, then the saved profile after save()', async () => {
    let stored: Profile | null = null;
    const hook = await mount({
      profiles: { getProfile: async () => stored, saveProfile: async (p) => (stored = p) },
    });
    expect(hook.status).toBe('ready');
    expect(hook.profile).toBeNull();
    let ok = false;
    await act(async () => {
      ok = await hook.save(maya);
    });
    expect(ok).toBe(true);
    expect(hook.profile).toEqual(maya);
  });

  it('a slower, older load cannot overwrite a newer one', async () => {
    const first = deferred<Profile | null>();
    const second = deferred<Profile | null>();
    const queue = [first, second];
    const hook = await mount({
      profiles: { getProfile: () => queue.shift()!.promise, saveProfile: async (p) => p },
    });
    expect(hook.status).toBe('loading');
    await act(async () => {
      hook.retry(); // starts the second load while the first is still pending
    });
    await act(async () => second.resolve(sam));
    await act(async () => first.resolve(maya)); // arrives late
    expect(hook.profile).toEqual(sam);
    expect(hook.status).toBe('ready');
  });

  it('reports a failed write as false and keeps the old profile', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const hook = await mount({
      profiles: { getProfile: async () => maya, saveProfile: async () => Promise.reject(new Error('no')) },
    });
    let ok = true;
    await act(async () => {
      ok = await hook.save(sam);
    });
    expect(ok).toBe(false);
    expect(hook.profile).toEqual(maya);
    error.mockRestore();
  });
});
