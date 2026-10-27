import type { MyList } from '../../data/courseApi';
import { checkedLabel, groupLists, listStarted, listTitle, refreshLimitMessage, statusLabel } from './listTitles';

const list = (over: Partial<MyList> = {}): MyList => ({
  id: 'c1', role: 'business analyst', status: 'ready', mode: 'list', visibility: 'private', industry: 'fintech', industryLabel: 'Fintech', customTitle: null,
  createdAt: '2026-10-19T12:00:00.000Z', lastActiveAt: '2026-10-19T12:00:00.000Z', checkedAt: null, refreshing: false, coverage: null, hasUpdates: false, ...over,
});

describe('a list\'s title', () => {
  it('is the name the reader gave it, if they gave one', () => {
    expect(listTitle(list({ customTitle: 'Treasury systems role' }))).toBe('Treasury systems role');
  });
  it('otherwise the role, the industry and the date it was started, composed on the device', () => {
    expect(listTitle(list(), 'en-US', 'UTC')).toBe('Business analyst · Fintech · Oct 19');
    expect(listTitle(list({ industry: null, industryLabel: null }), 'en-US', 'UTC')).toBe('Business analyst · Oct 19');
  });
  it('in the device\'s own language and date style', () => {
    expect(listTitle(list(), 'en-GB', 'UTC')).toBe('Business analyst · Fintech · 19 Oct');
    expect(listTitle(list(), 'de-DE', 'UTC')).toMatch(/^Business analyst · Fintech · 19\. Okt\.?$/);
  });
  it('capitalises only the first letter of the role', () => {
    expect(listTitle(list({ role: 'forward-deployed engineer', industry: null, industryLabel: null }), 'en-US', 'UTC')).toBe('Forward-deployed engineer · Oct 19');
  });
});

describe('when a list was started, for telling two alike lists apart', () => {
  it('is the date and time, composed on the device, for a list with the default name', () => {
    expect(listStarted(list(), 'en-US', 'UTC')).toMatch(/^Started Oct 19, 12:00\sPM$/);
    expect(listStarted(list({ createdAt: '2026-10-20T04:55:00.000Z' }), 'en-US', 'UTC')).toMatch(/^Started Oct 20, 4:55\sAM$/);
  });
  it('differs between two lists started on the same day', () => {
    expect(listStarted(list({ createdAt: '2026-10-20T03:00:00.000Z' }), 'en-US', 'UTC')).not.toBe(listStarted(list({ createdAt: '2026-10-20T05:00:00.000Z' }), 'en-US', 'UTC'));
  });
  it('is nothing for a list the reader named', () => {
    expect(listStarted(list({ customTitle: 'Treasury systems role' }), 'en-US', 'UTC')).toBeNull();
  });
});

describe('lists grouped by when they were last used', () => {
  const now = new Date('2026-10-19T15:00:00.000Z');
  const at = (iso: string, id: string) => list({ id, lastActiveAt: iso });
  it('Today, Yesterday, Previous 7 days and Older, in that order, with the lists in the order given and empty groups left out', () => {
    const groups = groupLists([at('2026-10-19T13:00:00.000Z', 'a'), at('2026-10-19T09:00:00.000Z', 'b'), at('2026-10-18T12:00:00.000Z', 'c'), at('2026-10-14T12:00:00.000Z', 'd'), at('2026-10-12T12:00:00.000Z', 'e'), at('2026-09-01T12:00:00.000Z', 'f')], now, 'UTC');
    expect(groups.map((g) => [g.title, g.lists.map((l) => l.id)])).toEqual([['Today', ['a', 'b']], ['Yesterday', ['c']], ['Previous 7 days', ['d', 'e']], ['Older', ['f']]]);
  });
  it('leaves out a group with nothing in it', () => {
    expect(groupLists([at('2026-10-19T13:00:00.000Z', 'a'), at('2026-08-01T12:00:00.000Z', 'z')], now, 'UTC').map((g) => g.title)).toEqual(['Today', 'Older']);
    expect(groupLists([], now, 'UTC')).toEqual([]);
  });
  it('eight days ago is Older, seven days ago is still Previous 7 days', () => {
    const groups = groupLists([at('2026-10-12T12:00:00.000Z', 'seven'), at('2026-10-11T12:00:00.000Z', 'eight')], now, 'UTC');
    expect(groups.map((g) => [g.title, g.lists.map((l) => l.id)])).toEqual([['Previous 7 days', ['seven']], ['Older', ['eight']]]);
  });
});

describe('when a list was last checked', () => {
  const now = new Date('2026-10-19T15:00:00.000Z');
  it('says so in plain words', () => {
    expect(checkedLabel(null, now)).toBe('Not checked yet');
    expect(checkedLabel('2026-10-19T14:59:40.000Z', now)).toBe('Checked just now');
    expect(checkedLabel('2026-10-19T14:25:00.000Z', now)).toBe('Checked 35 min ago');
    expect(checkedLabel('2026-10-19T11:00:00.000Z', now)).toBe('Checked 4 h ago');
    expect(checkedLabel('2026-10-15T11:00:00.000Z', now, 'en-US', 'UTC')).toBe('Checked Oct 15');
  });
});

describe('the status of a list', () => {
  it('says what is happening to a list that is not ready, or that it is being checked', () => {
    expect(statusLabel(list({ status: 'finding_sources' }))).toBe('Finding sources');
    expect(statusLabel(list({ status: 'awaiting_approval' }))).toBe('Getting started');
    expect(statusLabel(list({ status: 'building' }))).toBe('Building');
    expect(statusLabel(list({ status: 'failed' }))).toBe("Couldn't build");
    expect(statusLabel(list({ status: 'cancelled' }))).toBe('Cancelled');
    expect(statusLabel(list({ status: 'withdrawn' }))).toBe('Unavailable');
    expect(statusLabel(list({ refreshing: true }))).toBe('Checking for new sources');
    expect(statusLabel(list())).toBe('');
  });
});

describe('the once-an-hour message', () => {
  it('says when the list can be checked again, in the device\'s time style', () => {
    expect(refreshLimitMessage('2026-10-19T15:40:00.000Z', 'en-US', 'UTC')).toBe('You can check this list once an hour. Try again at 3:40 PM.');
    expect(refreshLimitMessage(undefined)).toBe('You can check this list once an hour. Try again a little later.');
  });
});
