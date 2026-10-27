import { badge } from '../theme';

/** Text for a count badge, or null when it should be hidden. Counts above `max` read "<max>+". */
export function badgeLabel(count: number, max: number = badge.maxCount): string | null {
  if (count <= 0) return null;
  return count > max ? `${max}+` : String(count);
}

/** The badge pops when the count goes up, never on the first value or when it drops. */
export function shouldPop(previous: number | null, next: number): boolean {
  return previous !== null && next > previous;
}
