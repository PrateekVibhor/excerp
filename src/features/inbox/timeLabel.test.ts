import { receivedLabel, rowTimeLabel } from './timeLabel';

// Local-time constructors, so the tests do not depend on the machine's timezone.
// "Now" is Sunday 4 October 2026, 15:00.
const NOW = new Date(2026, 9, 4, 15, 0);
const at = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m - 1, d, h, min).toISOString();

describe('rowTimeLabel', () => {
  it('shows the clock time for today', () => {
    expect(rowTimeLabel(at(2026, 10, 4, 9, 41), NOW)).toBe('9:41 AM');
    expect(rowTimeLabel(at(2026, 10, 4, 8, 2), NOW)).toBe('8:02 AM');
    expect(rowTimeLabel(at(2026, 10, 4, 18, 15), NOW)).toBe('6:15 PM');
  });

  it('writes midnight and noon as 12', () => {
    expect(rowTimeLabel(at(2026, 10, 4, 0, 5), NOW)).toBe('12:05 AM');
    expect(rowTimeLabel(at(2026, 10, 4, 12, 0), NOW)).toBe('12:00 PM');
    expect(rowTimeLabel(at(2026, 10, 4, 23, 59), new Date(2026, 9, 4, 23, 59))).toBe('11:59 PM');
  });

  it('says Yesterday for anything on the previous calendar day', () => {
    expect(rowTimeLabel(at(2026, 10, 3, 18, 15), NOW)).toBe('Yesterday');
    expect(rowTimeLabel(at(2026, 10, 3, 0, 1), NOW)).toBe('Yesterday');
    expect(rowTimeLabel(at(2026, 10, 3, 23, 59), NOW)).toBe('Yesterday');
  });

  it('goes by calendar days, not by 24-hour windows', () => {
    const justAfterMidnight = new Date(2026, 9, 4, 0, 10);
    expect(rowTimeLabel(at(2026, 10, 3, 23, 50), justAfterMidnight)).toBe('Yesterday'); // 20 minutes earlier
    expect(rowTimeLabel(at(2026, 10, 3, 0, 10), new Date(2026, 9, 4, 23, 50))).toBe('Yesterday'); // almost 48 hours earlier, but only one calendar day
  });

  it('shows the short weekday for 2 to 6 days ago', () => {
    expect(rowTimeLabel(at(2026, 10, 2, 11, 20), NOW)).toBe('Fri'); // 2 days
    expect(rowTimeLabel(at(2026, 10, 1, 11, 20), NOW)).toBe('Thu'); // 3 days
    expect(rowTimeLabel(at(2026, 9, 28, 16, 47), NOW)).toBe('Mon'); // 6 days
  });

  it('shows the date from 7 days ago', () => {
    expect(rowTimeLabel(at(2026, 9, 27, 16, 47), NOW)).toBe('Sep 27');
    expect(rowTimeLabel(at(2026, 9, 24, 9, 0), NOW)).toBe('Sep 24');
    expect(rowTimeLabel(at(2026, 1, 5, 9, 0), NOW)).toBe('Jan 5');
  });

  it('adds the year for another year, and counts across a month and year boundary', () => {
    expect(rowTimeLabel(at(2025, 12, 31, 9, 0), NOW)).toBe('Dec 31, 2025');
    expect(rowTimeLabel(at(2025, 12, 31, 9, 0), new Date(2026, 0, 1, 10, 0))).toBe('Yesterday');
    expect(rowTimeLabel(at(2026, 2, 28, 9, 0), new Date(2026, 2, 2, 10, 0))).toBe('Sat'); // 2 days across a month end
  });

  it('is not thrown off by a daylight-saving change', () => {
    // 8 March 2026 is when US clocks move forward; the day after is still "Yesterday".
    expect(rowTimeLabel(at(2026, 3, 8, 12, 0), new Date(2026, 2, 9, 12, 0))).toBe('Yesterday');
    expect(rowTimeLabel(at(2026, 3, 7, 12, 0), new Date(2026, 2, 9, 12, 0))).toBe('Sat');
  });

  it('shows the date for a time in the future, and nothing for an unreadable one', () => {
    expect(rowTimeLabel(at(2026, 10, 6, 9, 0), NOW)).toBe('Oct 6');
    expect(rowTimeLabel('not a date', NOW)).toBe('');
    expect(rowTimeLabel('', NOW)).toBe('');
  });

  it('uses the current time when no "now" is given', () => {
    expect(rowTimeLabel(new Date().toISOString())).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
  });
});

describe('receivedLabel', () => {
  it('matches the design: today, yesterday, weekday and date, each with the clock time', () => {
    expect(receivedLabel(at(2026, 10, 4, 9, 41), NOW)).toBe('today · 9:41 AM');
    expect(receivedLabel(at(2026, 10, 3, 18, 15), NOW)).toBe('yesterday · 6:15 PM');
    expect(receivedLabel(at(2026, 10, 1, 11, 20), NOW)).toBe('Thursday · 11:20 AM');
    expect(receivedLabel(at(2026, 9, 27, 16, 47), NOW)).toBe('Sep 27 · 4:47 PM');
  });

  it('uses the full weekday name for 2 to 6 days ago, and the year for another year', () => {
    expect(receivedLabel(at(2026, 10, 2, 8, 0), NOW)).toBe('Friday · 8:00 AM');
    expect(receivedLabel(at(2026, 9, 28, 8, 0), NOW)).toBe('Monday · 8:00 AM');
    expect(receivedLabel(at(2025, 9, 28, 16, 47), NOW)).toBe('Sep 28, 2025 · 4:47 PM');
  });

  it('is empty for an unreadable time', () => {
    expect(receivedLabel('nope', NOW)).toBe('');
  });
});
