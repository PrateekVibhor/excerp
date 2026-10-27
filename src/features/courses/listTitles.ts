/** Words and groupings for the reader's lists, worked out on the device (in its language and time zone) from what the server sends. */
import type { MyList } from '../../data/courseApi';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const date = (iso: string, locale?: string, timeZone?: string) => new Date(iso).toLocaleDateString(locale, { month: 'short', day: 'numeric', ...(timeZone ? { timeZone } : {}) });

/** The reader's own name for the list, or "Role · Industry · date" (the date it was started). */
export function listTitle(l: MyList, locale?: string, timeZone?: string): string {
  if (l.customTitle) return l.customTitle;
  return [cap(l.role), l.industryLabel, date(l.createdAt, locale, timeZone)].filter(Boolean).join(' · ');
}

/** "Started Oct 20, 11:55 PM" for a list with the default name, so two lists of one role and industry can be told apart; nothing for a list the reader named. */
export function listStarted(l: MyList, locale?: string, timeZone?: string): string | null {
  if (l.customTitle) return null;
  return `Started ${new Date(l.createdAt).toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) })}`;
}

/** Whole calendar days since the epoch, in the time zone given (the device's own when none). */
function dayNumber(d: Date, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...(timeZone ? { timeZone } : {}) }).formatToParts(d);
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(n('year'), n('month') - 1, n('day')) / 86_400_000;
}

export interface ListGroup { title: 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older'; lists: MyList[] }

/** Lists grouped by the day they were last used, the order inside a group kept as given; a group with nothing in it is left out. */
export function groupLists(lists: MyList[], now: Date, timeZone?: string): ListGroup[] {
  const today = dayNumber(now, timeZone);
  const groups: ListGroup[] = [{ title: 'Today', lists: [] }, { title: 'Yesterday', lists: [] }, { title: 'Previous 7 days', lists: [] }, { title: 'Older', lists: [] }];
  for (const l of lists) {
    const ago = today - dayNumber(new Date(l.lastActiveAt), timeZone);
    groups[ago <= 0 ? 0 : ago === 1 ? 1 : ago <= 7 ? 2 : 3]!.lists.push(l);
  }
  return groups.filter((g) => g.lists.length > 0);
}

/** "Checked 35 min ago" and so on. */
export function checkedLabel(checkedAt: string | null, now: Date, locale?: string, timeZone?: string): string {
  if (!checkedAt) return 'Not checked yet';
  const minutes = Math.floor((now.getTime() - new Date(checkedAt).getTime()) / 60_000);
  if (minutes < 1) return 'Checked just now';
  if (minutes < 60) return `Checked ${minutes} min ago`;
  if (minutes < 24 * 60) return `Checked ${Math.floor(minutes / 60)} h ago`;
  return `Checked ${date(checkedAt, locale, timeZone)}`;
}

/** What is happening to a list that is not simply ready; empty for a ready list nothing is happening to. */
export function statusLabel(l: MyList): string {
  switch (l.status) {
    case 'finding_sources': return 'Finding sources';
    case 'awaiting_approval': return 'Getting started';
    case 'building': return 'Building';
    case 'failed': return "Couldn't build";
    case 'cancelled': return 'Cancelled';
    case 'withdrawn': return 'Unavailable';
    default: return l.refreshing ? 'Checking for new sources' : '';
  }
}

/** The once-an-hour limit on checking a list, with when it can be checked again. */
export function refreshLimitMessage(retryAt: string | undefined, locale?: string, timeZone?: string): string {
  if (!retryAt) return 'You can check this list once an hour. Try again a little later.';
  const time = new Date(retryAt).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });
  return `You can check this list once an hour. Try again at ${time}.`;
}
