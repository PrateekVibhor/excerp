// Fakes for the phase 4 pipeline tests: a scripted model that answers every prompt the pipeline sends, a search client, an extract client and a
// YouTube client. Nothing here touches the network. The model reads the structure out of the prompts, so a test changes behaviour through options.
import type { Chat } from '../src/llm.ts';
import type { ExtractClient } from '../src/courses/pipeline/clients.ts';
import type { Hit, SearchClient } from '../src/courses/pipeline/postings.ts';
import type { YoutubeClient } from '../src/courses/pipeline/video.ts';
import type { VideoMeta } from '../src/courses/pipeline/videoScreen.ts';

export interface FakeModelOptions {
  /** Called with a label ("qa", "write", ...) and the prompt; return a string to replace the normal reply. */
  override?: (label: string, messages: { role: string; content: string }[]) => string | undefined;
  /** Claims the QA agent should flag as unsupported, by substring of the claim. */
  flag?: string[];
  /** What the library matcher answers: concept name -> library source ids. Concepts not listed match nothing. */
  libraryMatches?: Record<string, string[]>;
  /** Concepts (by name) that the teaches-not-mentions check should call only a mention; every other one it says is taught. */
  mentionOnly?: string[];
  /** What the skill-category mapper answers: phrase (lower case) -> { category, also? }. Any other phrase is answered "none". */
  mapAnswers?: Record<string, { category: string; also?: string; new_name?: string }>;
}

/** A posting's text carries its own skills and scenarios: "SKILLS: a, b | SCENARIOS: x, y". */
export const postingText = (skills: string[], scenarios: string[], extra = '') =>
  `Responsibilities: you will build and run systems for customers. Qualifications: experience. ${extra} SKILLS: ${skills.join(', ')} | SCENARIOS: ${scenarios.join(', ')} | ` + 'More detail about the role and the team. '.repeat(40);

const words = (n: number) => Array.from({ length: n }, (_, i) => `detail${i % 9}`).join(' ');

export function fakeModel(opts: FakeModelOptions = {}): Chat & { labels: string[] } {
  const labels: string[] = [];
  const chat = (async (messages: { role: string; content: string }[]) => {
    const system = messages[0]!.content;
    const user = messages.at(-1)!.content;
    const label =
      /You read one job posting/.test(system) ? 'read'
      : /Group skill names/.test(system) ? 'merge'
      : /For each requirement, decide/.test(system) ? 'delta'
      : /to a small library of trusted sources/.test(system) ? 'libmatch'
      : /to the transferable skill each one is really about/.test(system) ? 'taxmap'
      : /short display name for a learning list/.test(system) ? 'dispname'
      : /TEACHES a skill or only mentions it/.test(system) ? 'teach'
      : /Each item gives what a skill covers/.test(system) ? 'teachverify'
      : /web page is a good source/.test(system) ? 'page'
      : /List the facts about one skill/.test(system) ? 'facts'
      : /worth recommending/.test(system) ? 'video'
      : /design a learning path .* in four stages/.test(system) ? 'stages'
      : /list the prerequisite pairs/.test(system) ? 'prereq'
      : /plan one short story/.test(system) ? 'story'
      : /You write one chapter/.test(system) ? 'write'
      : /read the whole course/.test(system) ? 'coherence'
      : /new opening sentence/.test(system) ? 'openings'
      : /Check each item against one rule/.test(system) ? 'scope'
      : /You are a fact-checker/.test(system) ? 'qa'
      : /You write a short quiz/.test(system) ? 'quiz'
      : /You check a quiz/.test(system) ? 'verify'
      : 'other';
    labels.push(label);
    const replaced = opts.override?.(label, messages);
    if (replaced !== undefined) return replaced;
    switch (label) {
      case 'read': {
        const skills = /SKILLS: ([^|]*)\|/.exec(user)?.[1]?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
        const scenarios = /SCENARIOS: ([^|]*)\|/.exec(user)?.[1]?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
        return JSON.stringify({ title: 'Engineer', designation: '', location_country: 'United States', us_based: !/NOT-US/.test(user), skills, scenarios });
      }
      case 'merge': return JSON.stringify({ groups: [] });
      case 'delta': return JSON.stringify({ results: [] });
      case 'libmatch': {
        const asked = (JSON.parse(user) as { concepts: Array<{ name: string }> }).concepts;
        return JSON.stringify({ matches: asked.map((c) => ({ concept: c.name, sources: opts.libraryMatches?.[c.name] ?? [] })) });
      }
      case 'taxmap': {
        const asked = (JSON.parse(user) as { phrases: string[] }).phrases;
        return JSON.stringify({ results: asked.map((phrase, i) => ({ i, phrase, ...(opts.mapAnswers?.[phrase.toLowerCase()] ?? { category: 'none' }) })) });
      }
      case 'teach': {
        const ask = JSON.parse(user) as { categories: Array<{ id: string; excerpts: string[] }> };
        return JSON.stringify({ results: ask.categories.map((c) => ({ id: c.id, verdict: opts.mentionOnly?.includes(c.id) ? 'mentions' : 'teaches', evidence: (c.excerpts[0] ?? '').slice(10, 80) })) });
      }
      case 'teachverify': return JSON.stringify({ results: (JSON.parse(user) as { claims: Array<{ id: string }> }).claims.map((c) => ({ id: c.id, answer: 'yes' })) });
      case 'dispname': return JSON.stringify({ names: (JSON.parse(user) as { skills: string[] }).skills.map((skill) => ({ skill, name: skill.split(' ').slice(0, 3).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ') })) });
      case 'page': return JSON.stringify({ keep: true, kind: 'secondary', why: 'a clear explanation' });
      case 'facts': {
        const sentences = [...user.matchAll(/([A-Z][^.]{20,200}\.)/g)].map((m) => m[1]!).filter((s) => /\bis\b|\bare\b/.test(s));
        return JSON.stringify({ facts: [...new Set(sentences)].slice(0, 3).map((text) => ({ text, kind: 'practice' })) });
      }
      case 'video': return JSON.stringify({ keep: true, why: 'a practitioner explaining their work' });
      case 'stages': {
        const n = (user.match(/^\d+\./gm) ?? []).length;
        return JSON.stringify({ stages: Array.from({ length: n }, (_, i) => 1 + (i % 4)) });
      }
      case 'prereq': return JSON.stringify({ edges: [] });
      case 'story': {
        const shape = JSON.parse(user).sections as string[][][];
        return JSON.stringify({
          bible: { setting: 'A small product team', character: 'Sam, the newest engineer on the team', thread: 'Sam learns by working real situations', voice: 'plain, practical' },
          sections: shape.map((s, i) => ({ title: `Keeping the service healthy, part ${i + 1}`, summary: 'What this part covers.', chapters: s.map((c, k) => `Sam works through ${c[0]} (${i + 1}.${k + 1})`) })),
        });
      }
      case 'write': {
        const names = [...user.matchAll(/^- (.+?)$/gm)].map((m) => m[1]!);
        const facts = [...user.matchAll(/^\s+\* (.+)$/gm)].map((m) => m[1]!);
        return `Sam started the day with ${names.join(' and ')} in mind. ${facts.join(' ')} ${words(150)} Then Sam wrote down what worked.`;
      }
      case 'coherence': return JSON.stringify({ issues: [] });
      case 'openings': return JSON.stringify({ openings: [] });
      case 'scope': {
        const items = JSON.parse(/<items>([\s\S]*)<\/items>/.exec(user)![1]!) as Array<{ id: string }>;
        return JSON.stringify({ results: items.map((i) => ({ id: i.id, ok: true, why: '' })) });
      }
      case 'qa': {
        const chapter = /<chapter>\n([\s\S]*)\n<\/chapter>/.exec(user)![1]!;
        const sentences = chapter.split(/(?<=[.!?])\s+/).filter((s) => s.length > 30).slice(0, 4);
        return JSON.stringify({ claims: sentences.map((text) => ({ text, verdict: opts.flag?.some((f) => text.includes(f)) ? 'unsupported' : 'supported', category: null, quote: '' })) });
      }
      case 'quiz': return JSON.stringify({ topic: null, questions: QUIZ });
      case 'verify': return JSON.stringify({ supported: [['A'], ['A'], ['A']] });
      default: return '{}';
    }
  }) as Chat & { labels: string[] };
  chat.labels = labels;
  return chat;
}

export const QUIZ = [
  { prompt: 'What does a query plan show?', options: ['How the database runs a query', 'Who wrote the query', 'The price of a query', 'When the query was first made'], correct_index: 0 },
  { prompt: 'What should you do before changing a failing system?', options: ['Reproduce the failure first', 'Restart every server at once', 'Delete the logs for space', 'Ask for a new laptop today'], correct_index: 0 },
  { prompt: 'Why add an index to a column?', options: ['Reads on it get faster', 'The table becomes smaller', 'Writes no longer cost anything', 'Backups run twice as fast'], correct_index: 0 },
];

/** Two publishers per concept, both stating the same plain sentences, so the two-source rule is met. */
export function fakeSearch(): SearchClient & { calls: number } {
  const client = {
    calls: 0,
    async search(p: { query: string }): Promise<Hit[]> {
      client.calls++;
      const topic = p.query.split(' for a ')[0]!.split(' ').slice(0, 3).join(' ');
      const T = topic[0]!.toUpperCase() + topic.slice(1);
      const text = `${T} is how the work gets done in practice. A team that practises ${topic} reviews its results often. ${T} is checked against real examples. ` + 'Additional explanation of the idea follows here. '.repeat(30);
      return [
        { url: `https://one.example.org/${encodeURIComponent(topic)}`, title: `${topic} explained`, text },
        { url: `https://two.example.net/${encodeURIComponent(topic)}`, title: `${topic}: a guide`, text },
      ];
    },
  };
  return client;
}

export function fakeExtract(texts: Record<string, string>): ExtractClient & { calls: string[][] } {
  const calls: string[][] = [];
  return { calls, extract: async (urls) => (calls.push(urls), Object.fromEntries(urls.filter((u) => texts[u]).map((u) => [u, texts[u]!]))) };
}

export function fakeYoutube(videos: VideoMeta[] = []): YoutubeClient {
  return { search: async () => videos.map((v) => v.id), videos: async (ids) => videos.filter((v) => ids.includes(v.id)) };
}
