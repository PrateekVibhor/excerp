// Plan 16, part 3: the industries a reader may pick when asking for a course. The key is what the API takes and the course keeps; the phrase is what
// the reference research puts in its queries and prompts (at most six words, the same limit the pipeline's own guess has). A course with no
// industry is one where none was chosen, and the pipeline guesses as it always did.
export const INDUSTRIES = [
  { key: 'fintech', label: 'Fintech', phrase: 'fintech and payments software' },
  { key: 'banking', label: 'Banking', phrase: 'retail and commercial banking' },
  { key: 'insurance', label: 'Insurance', phrase: 'insurance and insurtech' },
  { key: 'technology', label: 'Technology and software', phrase: 'software and SaaS companies' },
  { key: 'healthcare', label: 'Healthcare', phrase: 'healthcare providers and health tech' },
  { key: 'life-sciences', label: 'Pharma and life sciences', phrase: 'pharmaceutical and life sciences' },
  { key: 'supply-chain', label: 'Supply chain and logistics', phrase: 'supply chain and logistics' },
  { key: 'e-commerce', label: 'E-commerce', phrase: 'e-commerce and online marketplaces' },
  { key: 'retail', label: 'Retail', phrase: 'retail and consumer goods' },
  { key: 'manufacturing', label: 'Manufacturing', phrase: 'manufacturing and industrial' },
  { key: 'telecommunications', label: 'Telecommunications', phrase: 'telecommunications and networks' },
  { key: 'energy', label: 'Energy and utilities', phrase: 'energy and utilities' },
  { key: 'media', label: 'Media and entertainment', phrase: 'media and entertainment' },
  { key: 'education', label: 'Education', phrase: 'education and ed tech' },
  { key: 'government', label: 'Government and public sector', phrase: 'government and public sector' },
] as const;

export type IndustryKey = (typeof INDUSTRIES)[number]['key'];

export const isIndustryKey = (value: unknown): value is IndustryKey => typeof value === 'string' && INDUSTRIES.some((i) => i.key === value);

/** The research phrase for a stored industry key; empty for no industry (and for a key that is no longer listed). */
export const industryPhrase = (key: string): string => INDUSTRIES.find((i) => i.key === key)?.phrase ?? '';
