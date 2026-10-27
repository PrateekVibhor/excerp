import AsyncStorage from '@react-native-async-storage/async-storage';
import { createLocalStore } from './localStore';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const USER = 'user-1';
const swipe = (article_id: string, direction: 'left' | 'right', user_id = USER) => ({
  user_id,
  article_id,
  direction,
  swiped_at: '2026-10-03T10:00:00Z',
});

// A new store over the same storage stands in for an app restart.
const open = () => createLocalStore(AsyncStorage);

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('local store: saved items', () => {
  it('saves an item and lists newest first', async () => {
    const store = open();
    await store.add(USER, 'a');
    await store.add(USER, 'b');
    expect((await store.list(USER)).map((i) => i.article_id)).toEqual(['b', 'a']);
  });

  it('does not duplicate an already saved article', async () => {
    const store = open();
    await store.add(USER, 'a');
    await store.add(USER, 'a');
    expect(await store.list(USER)).toHaveLength(1);
  });

  it('removes an item', async () => {
    const store = open();
    await store.add(USER, 'a');
    await store.add(USER, 'b');
    await store.remove(USER, 'a');
    expect((await store.list(USER)).map((i) => i.article_id)).toEqual(['b']);
  });

  it('persists across a restart', async () => {
    await open().add(USER, 'a');
    await open().add(USER, 'b');
    await open().remove(USER, 'a');
    expect((await open().list(USER)).map((i) => i.article_id)).toEqual(['b']);
  });

  it('keeps lists per user', async () => {
    const store = open();
    await store.add(USER, 'a');
    expect(await store.list('user-2')).toEqual([]);
  });
});

describe('local store: swipes', () => {
  it('records swipes in either direction and persists them', async () => {
    await open().recordSwipe(swipe('a', 'right'));
    await open().recordSwipe(swipe('b', 'left'));
    expect(await open().getSwipedIds(USER)).toEqual(new Set(['a', 'b']));
  });

  it('keeps swipes per user', async () => {
    const store = open();
    await store.recordSwipe(swipe('a', 'right'));
    expect((await store.getSwipedIds('user-2')).size).toBe(0);
  });

  it('a swipe alone does not save the article', async () => {
    const store = open();
    await store.recordSwipe(swipe('a', 'right'));
    expect(await store.list(USER)).toEqual([]);
  });
});

describe('local store: concurrent writes', () => {
  it('keeps every write when a swipe and a save overlap', async () => {
    const store = open();
    await Promise.all([
      store.recordSwipe(swipe('a', 'right')),
      store.add(USER, 'a'),
      store.recordSwipe(swipe('b', 'left')),
      store.add(USER, 'c'),
    ]);
    expect(await store.getSwipedIds(USER)).toEqual(new Set(['a', 'b']));
    expect((await store.list(USER)).map((i) => i.article_id)).toEqual(['c', 'a']);
  });
});

describe('local store: stored data', () => {
  it('holds only ids and timestamps', async () => {
    await open().add(USER, 'a');
    const raw = await AsyncStorage.getItem('swipy:reading_list');
    expect(Object.keys(JSON.parse(raw as string)[0]).sort()).toEqual(
      ['article_id', 'id', 'saved_at', 'user_id'],
    );
  });
});

describe('local store: change notifications', () => {
  it('notifies when an item is added or removed', async () => {
    const store = open();
    const listener = jest.fn();
    store.subscribe(listener);
    await store.add(USER, 'a');
    expect(listener).toHaveBeenCalledTimes(1);
    await store.remove(USER, 'a');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('stays quiet when nothing changed', async () => {
    const store = open();
    const listener = jest.fn();
    await store.add(USER, 'a');
    store.subscribe(listener);
    await store.add(USER, 'a'); // already saved
    await store.remove(USER, 'zzz'); // not saved
    await store.recordSwipe(swipe('b', 'left')); // swipes are not saved items
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops notifying after unsubscribe', async () => {
    const store = open();
    const listener = jest.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    await store.add(USER, 'a');
    expect(listener).not.toHaveBeenCalled();
  });
});


describe('local store: profile', () => {
  const maya = { display_name: 'Maya', industry: 'Software', interests: ['Agents', 'Cloud'] } as const;

  it('is null before anything is saved', async () => {
    expect(await open().getProfile()).toBeNull();
  });

  it('saves a profile and reads it back', async () => {
    const store = open();
    expect(await store.saveProfile({ ...maya, interests: [...maya.interests] })).toEqual(maya);
    expect(await store.getProfile()).toEqual(maya);
  });

  it('overwrites: only the new values are stored', async () => {
    const store = open();
    await store.saveProfile({ ...maya, interests: [...maya.interests] });
    await store.saveProfile({ display_name: 'Maya C', industry: 'Finance', interests: ['Safety'] });
    expect(await store.getProfile()).toEqual({
      display_name: 'Maya C',
      industry: 'Finance',
      interests: ['Safety'],
    });
  });

  it('persists across a restart', async () => {
    await open().saveProfile({ ...maya, interests: [...maya.interests] });
    expect(await open().getProfile()).toEqual(maya);
  });

  it('does not touch saved items, swipes or their listeners', async () => {
    const store = open();
    const listener = jest.fn();
    await store.add(USER, 'a');
    await store.recordSwipe(swipe('a', 'right'));
    store.subscribe(listener);
    await store.saveProfile({ ...maya, interests: [...maya.interests] });
    expect(listener).not.toHaveBeenCalled();
    expect((await store.list(USER)).map((i) => i.article_id)).toEqual(['a']);
    expect(await store.getSwipedIds(USER)).toEqual(new Set(['a']));
  });
});

describe('local store: things from another phone of the same account', () => {
  it('putSaved adds an item with the time it was saved elsewhere, in time order, and tells the reading-list listeners', async () => {
    const store = open();
    const listener = jest.fn();
    store.subscribe(listener);
    await store.add(USER, 'later');
    const addedAt = (await store.list(USER))[0].saved_at;
    expect(await store.putSaved(USER, 'earlier', '2020-01-01T00:00:00.000Z')).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
    expect((await store.list(USER)).map((i) => [i.article_id, i.saved_at])).toEqual([['later', addedAt], ['earlier', '2020-01-01T00:00:00.000Z']]); // newest first
  });
  it('putSaved changes nothing and says so when the article is already saved', async () => {
    const store = open();
    await store.add(USER, 'a');
    const listener = jest.fn();
    store.subscribe(listener);
    expect(await store.putSaved(USER, 'a', '2020-01-01T00:00:00.000Z')).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect((await store.list(USER))[0].saved_at).not.toBe('2020-01-01T00:00:00.000Z');
  });
  it('getSkippedIds lists the articles swiped left, one per swipe, oldest first, for that user only', async () => {
    const store = open();
    await store.recordSwipe(swipe('a', 'left'));
    await store.recordSwipe(swipe('b', 'right'));
    await store.recordSwipe(swipe('a', 'left'));
    await store.recordSwipe(swipe('c', 'left', 'someone-else'));
    expect(await store.getSkippedIds(USER)).toEqual(['a', 'a']);
    expect(await open().getSkippedIds('nobody')).toEqual([]);
  });
  it('subscribeToProfile is called after a profile is saved, until unsubscribed', async () => {
    const store = open();
    const listener = jest.fn();
    const off = store.subscribeToProfile(listener);
    await store.saveProfile({ display_name: 'Maya', industry: 'Software', interests: ['Cloud'] });
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    await store.saveProfile({ display_name: 'Maya C', industry: 'Software', interests: ['Cloud'] });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
