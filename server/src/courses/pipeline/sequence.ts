// Plan 16, phase 4, stage 7: the one function behind which the sequencing approach lives (spec 16, section 6, stage 7; R1 chose approach B).
// B: four stages, the more-asked-for first inside a stage. The automatic order check asks for prerequisites and, if more than a fifth of the
// named pairs are broken, repairs the order from the prerequisites instead. Any model failure leaves a working order.
import type { Chat } from '../../llm.ts';
import { pairViolations, stageOrder, topoOrder, type Edge } from './order.ts';
import { askPrerequisites, askStages } from './orderModels.ts';

export interface SequenceResult {
  order: string[];
  approach: 'B' | 'A-repair' | 'baseline';
  /** Prerequisite pairs the final order breaks, of the pairs the model named. */
  violations: number;
  edges: number;
}

const MAX_BROKEN = 0.2;

export async function sequenceConcepts(chat: Chat, role: string, concepts: Array<{ name: string; mentions: number }>): Promise<SequenceResult> {
  const names = concepts.map((c) => c.name);
  const mentions = new Map(concepts.map((c) => [c.name, c.mentions]));
  const priority = (c: string) => mentions.get(c) ?? 0;

  let stages: Record<string, number> | null = null;
  for (let attempt = 0; attempt < 2 && !stages; attempt++) {
    try {
      stages = await askStages(chat, role, names);
    } catch { /* retry once */ }
  }
  if (!stages) {
    const order = [...names].sort((a, b) => priority(b) - priority(a) || a.localeCompare(b));
    return { order, approach: 'baseline', violations: 0, edges: 0 };
  }
  const staged = stageOrder(stages, priority);

  let edges: Edge[] = [];
  try {
    edges = await askPrerequisites(chat, role, names);
  } catch { /* the stage order stands without the check */ }
  const pairs = edges.map(([a, b]) => ({ a, b, first: 'a' as const }));
  const broken = pairViolations(staged, pairs);
  if (edges.length > 0 && broken.violations / edges.length > MAX_BROKEN) {
    const repaired = topoOrder(names, edges, priority).order;
    return { order: repaired, approach: 'A-repair', violations: pairViolations(repaired, pairs).violations, edges: edges.length };
  }
  return { order: staged, approach: 'B', violations: broken.violations, edges: edges.length };
}
