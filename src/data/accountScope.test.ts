import AsyncStorage from '@react-native-async-storage/async-storage';
import { createRepositories, LOCAL_USER_ID } from './index';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const A = 'EXC-7K4Q-92M3';
const B = 'EXC-0000-ABCD';
const open = () => createRepositories({ source: 'mock', apiUrl: undefined, storage: AsyncStorage });
const maya = { display_name: 'Maya', industry: 'Software', interests: ['Cloud'] } as const;
const sam = { display_name: 'Sam', industry: 'Finance', interests: ['Safety'] } as const;

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('accounts on one phone, through the real repositories', () => {
  it('Scenario: A second Google account sees only its own profile, reading list and badges, and the first gets everything back', async () => {
    const r = open();
    await r.accountScope.activate(A);
    await r.profileRepository.saveProfile({ ...maya, interests: [...maya.interests] });
    await r.readingListRepository.add(LOCAL_USER_ID, 'article-1');
    await r.verifiedRepository.add('article-1', 'Cloud');

    await r.accountScope.activate(null);
    await r.accountScope.activate(B);
    expect(await r.profileRepository.getProfile()).toBeNull();
    expect(await r.readingListRepository.list(LOCAL_USER_ID)).toEqual([]);
    expect(await r.verifiedRepository.list()).toEqual([]);
    await r.profileRepository.saveProfile({ ...sam, interests: [...sam.interests] });
    await r.verifiedRepository.add('article-2', 'Safety');

    await r.accountScope.activate(null);
    await r.accountScope.activate(A);
    expect(await r.profileRepository.getProfile()).toEqual(maya);
    expect((await r.readingListRepository.list(LOCAL_USER_ID)).map((i) => i.article_id)).toEqual(['article-1']);
    expect((await r.verifiedRepository.list()).map((v) => v.article_id)).toEqual(['article-1']);
  });

  it('Scenario: The first account to sign in after the update takes over what was already on the phone; a second one does not', async () => {
    const before = open(); // the app as it was: no account, unscoped keys
    await before.profileRepository.saveProfile({ ...maya, interests: [...maya.interests] });
    await before.verifiedRepository.add('old-badge', 'Cloud');

    const r = open(); // after the update
    await r.accountScope.activate(A);
    expect(await r.profileRepository.getProfile()).toEqual(maya);
    expect((await r.verifiedRepository.list()).map((v) => v.article_id)).toEqual(['old-badge']);
    await r.accountScope.activate(null);
    await r.accountScope.activate(B);
    expect(await r.profileRepository.getProfile()).toBeNull();
    expect(await r.verifiedRepository.list()).toEqual([]);
  });

  it('the phone\'s own device id is the same whichever account is active', async () => {
    const r = open();
    await r.accountScope.activate(A);
    const id = await r.deviceIdRepository.get();
    await r.accountScope.activate(null);
    await r.accountScope.activate(B);
    expect(await r.deviceIdRepository.get()).toBe(id);
  });

  it('with no account active the repositories use the old keys, as before accounts', async () => {
    const r = open();
    await r.profileRepository.saveProfile({ ...maya, interests: [...maya.interests] });
    expect(await AsyncStorage.getItem('swipy:profile')).not.toBeNull();
  });

  it('refuses something that is not an account reference, and the phone stays on the account it was on', async () => {
    const r = open();
    await r.accountScope.activate(A);
    await r.profileRepository.saveProfile({ ...maya, interests: [...maya.interests] });
    await expect(r.accountScope.activate('../../x')).rejects.toThrow(RangeError);
    expect(await r.profileRepository.getProfile()).toEqual(maya);
  });

  it('on mock data there is nothing to sync with, and asking is harmless', async () => {
    const r = open();
    await r.accountSync.start();
    await r.accountSync.syncNow();
    expect(r.accountSync.enabled()).toBe(false);
  });

  it('Scenario: wipe removes this account\'s data from the phone and nobody else\'s, and the phone\'s own id', async () => {
    const r = open();
    await r.accountScope.activate(A);
    await r.profileRepository.saveProfile({ ...maya, interests: [...maya.interests] });
    await r.readingListRepository.add(LOCAL_USER_ID, 'article-1');
    await r.readingListRepository.recordSwipe({ user_id: LOCAL_USER_ID, article_id: 'x', direction: 'left', swiped_at: 't' });
    await r.verifiedRepository.add('article-1', 'Cloud');
    await AsyncStorage.setItem(`swipy:acct:${A}:inbox`, '["left over from the old version"]'); // an old key, in a place the app no longer reads
    const deviceId = await r.deviceIdRepository.get();
    await r.accountScope.activate(null);
    await r.accountScope.activate(B);
    await r.profileRepository.saveProfile({ ...sam, interests: [...sam.interests] });

    await r.accountScope.activate(null);
    await r.accountScope.activate(A);
    await r.accountScope.wipe();
    expect(await r.profileRepository.getProfile()).toBeNull();
    expect(await r.readingListRepository.list(LOCAL_USER_ID)).toEqual([]);
    expect(await r.verifiedRepository.list()).toEqual([]);
    const left = (await AsyncStorage.getAllKeys()).filter((k) => k.includes(A));
    expect(left).toEqual([]); // not one key of this account is left, not even the sync state
    await r.accountScope.activate(null);
    await r.accountScope.activate(B);
    expect(await r.profileRepository.getProfile()).toEqual(sam);
    expect(await AsyncStorage.getItem('swipy:device_id')).toBe(deviceId);
  });

  it('wipe with no account active does nothing at all (it must never clear the keys of before accounts by mistake)', async () => {
    const r = open();
    await r.profileRepository.saveProfile({ ...maya, interests: [...maya.interests] });
    await r.accountScope.wipe();
    expect(await r.profileRepository.getProfile()).toEqual(maya);
  });
});
