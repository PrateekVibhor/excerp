const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Whole calendar days from `then` to `now` on the device's clock; negative if `then` is later. */
function daysAgo(then: Date, now: Date): number {
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((day(now) - day(then)) / 86_400_000);
}

/** "9:41 AM", "6:15 PM", "12:05 AM". */
function clock(d: Date): string {
  const hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${hours % 12 || 12}:${minutes} ${hours < 12 ? 'AM' : 'PM'}`;
}

/** "Sep 28", or "Sep 28, 2025" when it is not this year. */
function date(d: Date, now: Date): string {
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

/**
 * The label on an inbox row: the clock time today, "Yesterday", the short weekday for the
 * rest of the last week (2 to 6 days ago), and the date after that. Empty for an unreadable time.
 */
export function rowTimeLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = daysAgo(d, now);
  if (days === 0) return clock(d);
  if (days === 1) return 'Yesterday';
  if (days >= 2 && days <= 6) return WEEKDAYS[d.getDay()].slice(0, 3);
  return date(d, now);
}

/** The line on the message screen: "today · 9:41 AM", "Thursday · 11:20 AM", "Sep 28 · 4:47 PM". */
export function receivedLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = daysAgo(d, now);
  const day = days === 0 ? 'today' : days === 1 ? 'yesterday' : days >= 2 && days <= 6 ? WEEKDAYS[d.getDay()] : date(d, now);
  return `${day} · ${clock(d)}`;
}
