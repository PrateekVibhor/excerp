import type { SourceCompany } from '../../data';
import { colors } from '../../theme';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-09-24T09:00:00Z" -> "Sep 24". UTC, so the day does not shift with the device timezone. */
export function formatPublishedDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * Short domain for the card: the host's last two labels, so the line fits next
 * to the content-type tag. "https://research.nvidia.com/" -> "nvidia.com",
 * "https://research.google/" -> "research.google".
 * Assumes single-part TLDs, which holds for every supported source company.
 */
export function sourceDomain(url: string): string {
  const match = url.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i);
  if (!match) return '';
  return match[1].toLowerCase().split('.').slice(-2).join('.');
}

export function readersLabel(count: number): string {
  return count === 1 ? '1 person is reading this' : `${count} people are reading this`;
}

export const monograms: Record<SourceCompany, string> = {
  NVIDIA: 'N',
  Anthropic: 'A',
  Google: 'G',
  Meta: 'M',
  OpenAI: 'O',
  Microsoft: 'Ms',
  AWS: 'aws',
  McKinsey: 'Mc',
  BCG: 'BCG',
  'Bain & Company': 'B',
  'CFA Institute': 'CFA',
  'Harvard Business Review': 'HBR',
  'MIT Sloan Management Review': 'SMR',
  BlackRock: 'BR',
  'World Economic Forum': 'WEF',
  'Y Combinator': 'YC',
  'Sequoia Capital': 'S',
  'Andreessen Horowitz': 'a16z',
  'General Catalyst': 'GC',
};

// The API can send a publisher or tag this build has never heard of (a newer server, an older app).
// These show it in neutral colors instead of failing on the missing table entry.
const UNKNOWN_BRAND = { bg: colors.glass.tabActive, fg: colors.text.tertiary };
const UNKNOWN_TAG = { fg: colors.text.secondary, bg: colors.glass.chip };

export const brandFor = (company: string): { bg: string; fg: string } => (colors.brand as Record<string, { bg: string; fg: string }>)[company] ?? UNKNOWN_BRAND;
export const tagFor = (type: string): { fg: string; bg: string } => (colors.tag as Record<string, { fg: string; bg: string }>)[type] ?? UNKNOWN_TAG;
export const monogramFor = (company: string): string => (monograms as Record<string, string>)[company] ?? (company.trim().charAt(0).toUpperCase() || '?');
