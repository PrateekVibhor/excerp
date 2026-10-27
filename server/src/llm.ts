import type { ContentType } from '../../src/data/types.ts';
import { TECH_TYPES, type TagRule } from './config.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Sends messages to the model and resolves with the text of its reply. */
export type Chat = (messages: ChatMessage[]) => Promise<string>;

export interface ArticleInput {
  title: string;
  url: string;
  text: string;
}

export interface Summary {
  summary: string;
  content_type: ContentType;
}

/** `failures` lists why each rejected attempt failed, in order, so retries can be logged and studied. */
export type SummarizeResult =
  | { ok: true; value: Summary; attempts: number; failures: string[] }
  | { ok: false; reason: string; attempts: number; failures: string[] };

export const MIN_WORDS = 50;
export const MAX_WORDS = 60;
/** About 3,000 tokens of page text: enough to summarize, cheap enough to run often. */
export const MAX_INPUT_CHARS = 12_000;

/** How the model is told to pick a type when the source does not fix one. Tech companies: the original four. */
export const DEFAULT_TAGS: TagRule = { choose: TECH_TYPES };

const TYPE_HELP: Record<ContentType, string> = {
  'Research Paper': '"Research Paper" for papers reporting research results',
  'White Paper': '"White Paper" for in-depth guides, reports or frameworks',
  Release: '"Release" for announcements of a product, model, version or feature',
  'Tech Blog': '"Tech Blog" for engineering or technical blog posts',
  Consulting: '"Consulting" for management, strategy, operations and technology-adoption advice for organizations',
  Finance: '"Finance" for investing, markets, asset management, economics and financial services',
  'Venture Capital': '"Venture Capital" for startups, founders, funding, building companies and venture investing',
};

const ORDER_FOR_TECH: readonly ContentType[] = ['Research Paper', 'White Paper', 'Release', 'Tech Blog'];

/** The instructions for the model. The seven tech companies keep the wording they were tested with. */
export function systemPrompt(rule: TagRule = DEFAULT_TAGS): string {
  if ('fixed' in rule) {
    return [
      'You summarize business and finance articles for a reading app.',
      'Reply with one JSON object and nothing else: {"summary": string}.',
      `The summary must be ${MIN_WORDS} to ${MAX_WORDS} words. Count the words carefully before answering.`,
      'Write in a factual tone with no marketing language. Say what the article argues or found, and why it matters.',
    ].join(' ');
  }
  const isTech = rule.choose.every((t) => TECH_TYPES.includes(t));
  const types = isTech ? ORDER_FOR_TECH.filter((t) => rule.choose.includes(t)) : rule.choose;
  const list = rule.choose.map((t) => `"${t}"`).join(', ');
  return [
    isTech ? 'You summarize technology articles for a reading app.' : 'You summarize business and finance articles for a reading app.',
    'Reply with one JSON object and nothing else:',
    `{"summary": string, "content_type": one of ${list}}.`,
    `The summary must be ${MIN_WORDS} to ${MAX_WORDS} words. Count the words carefully before answering.`,
    isTech
      ? 'Write in a factual tone with no marketing language. Say what was released or found, and why it matters.'
      : 'Write in a factual tone with no marketing language. Say what the article argues or found, and why it matters.',
    `content_type: ${types.map((t) => TYPE_HELP[t]).join('; ')}.`,
  ].join(' ');
}

/** Words counted the same way as the database rule: runs of non-whitespace. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

export function buildMessages(article: ArticleInput, maxChars = MAX_INPUT_CHARS, rule: TagRule = DEFAULT_TAGS): ChatMessage[] {
  const text = article.text.length > maxChars ? `${article.text.slice(0, maxChars)} [truncated]` : article.text;
  return [
    { role: 'system', content: systemPrompt(rule) },
    { role: 'user', content: `Title: ${article.title}\nURL: ${article.url}\nText:\n${text}` },
  ];
}

/**
 * Finds the JSON object in a model reply. Tolerates reasoning in <think> tags,
 * code fences and text around the object.
 */
export function extractJson(reply: string): unknown {
  const withoutThinking = reply.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const start = withoutThinking.indexOf('{');
  const end = withoutThinking.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('reply contains no JSON object');
  try {
    return JSON.parse(withoutThinking.slice(start, end + 1));
  } catch {
    throw new Error('reply is not valid JSON');
  }
}

export type Validation = { ok: true; value: Summary } | { ok: false; reason: string };

/**
 * Checks the parsed reply against the spec's rules and returns it in its stored form. With a fixed tag the
 * model's own content_type is ignored; otherwise it must be one of the types the source allows.
 */
export function validateSummary(raw: unknown, rule: TagRule = DEFAULT_TAGS): Validation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'reply is not a JSON object' };
  const { summary, content_type } = raw as Record<string, unknown>;
  if (typeof summary !== 'string') return { ok: false, reason: 'summary is missing or not a string' };
  const normalized = summary.trim().replace(/\s+/g, ' ');
  const words = countWords(normalized);
  if (words < MIN_WORDS || words > MAX_WORDS) {
    return { ok: false, reason: `summary has ${words} words; it must have ${MIN_WORDS} to ${MAX_WORDS}` };
  }
  if ('fixed' in rule) return { ok: true, value: { summary: normalized, content_type: rule.fixed } };
  const type = typeof content_type === 'string'
    ? rule.choose.find((t) => t.toLowerCase() === content_type.trim().toLowerCase())
    : undefined;
  if (!type) {
    return { ok: false, reason: `content_type ${JSON.stringify(content_type ?? null)} is not one of ${rule.choose.join(', ')}` };
  }
  return { ok: true, value: { summary: normalized, content_type: type } };
}

export interface SummarizeOptions {
  /** Retries after the first attempt. The spec allows 2. */
  retries?: number;
  /** Waits between attempts; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  retryDelayMs?: number;
  /** How this source's content type is decided. Defaults to the tech companies' four types. */
  tags?: TagRule;
}

/**
 * Asks the model for a summary and content type, validating every reply. An invalid
 * reply or a failed call is retried up to `retries` times, telling the model what was
 * wrong. Never throws: after the last attempt it returns the reason, so the pipeline
 * can skip the article and carry on.
 */
export async function summarize(article: ArticleInput, chat: Chat, options: SummarizeOptions = {}): Promise<SummarizeResult> {
  const { retries = 2, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retryDelayMs = 1000, tags = DEFAULT_TAGS } = options;
  const messages = buildMessages(article, MAX_INPUT_CHARS, tags);
  const failures: string[] = [];
  let reason = 'no attempt was made';

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    if (attempt > 1) await sleep(retryDelayMs * (attempt - 1));
    let reply: string;
    try {
      reply = await chat(messages);
    } catch (error) {
      reason = `model call failed: ${(error as Error).message}`;
      failures.push(reason);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = extractJson(reply);
    } catch (error) {
      reason = (error as Error).message;
      failures.push(reason);
      messages.push({ role: 'assistant', content: reply }, { role: 'user', content: `That was not usable: ${reason}. Reply with the JSON object only.` });
      continue;
    }
    const result = validateSummary(parsed, tags);
    if (result.ok) return { ok: true, value: result.value, attempts: attempt, failures };
    reason = result.reason;
    failures.push(reason);
    messages.push({ role: 'assistant', content: reply }, { role: 'user', content: `That was not usable: ${reason}. Try again and reply with the JSON object only.` });
  }
  return { ok: false, reason, attempts: retries + 1, failures };
}

export interface NebiusOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Large enough for the model's hidden reasoning plus the JSON. */
  maxTokens?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  /** Called with the token counts of every successful reply, for cost reporting. */
  onUsage?: (usage: TokenUsage) => void;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** A Chat that calls a Nemotron model through Nebius Token Factory's OpenAI-compatible API. */
export function createNebiusChat({
  apiKey,
  model,
  baseUrl = 'https://api.tokenfactory.nebius.com/v1',
  maxTokens = 8000,
  timeoutMs = 60_000,
  fetchFn = fetch,
  onUsage,
}: NebiusOptions): Chat {
  return async (messages) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: maxTokens }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Report the status only: response bodies can echo request details.
        throw new Error(`Token Factory answered HTTP ${res.status}`);
      }
      const body = (await res.json()) as { choices?: { message?: { content?: string | null }; finish_reason?: string }[]; usage?: TokenUsage };
      if (body.usage && onUsage) onUsage(body.usage);
      const choice = body.choices?.[0];
      if (choice?.finish_reason === 'length') throw new Error('reply was cut off at the token limit');
      const content = choice?.message?.content;
      if (typeof content !== 'string' || content.trim() === '') throw new Error('reply was empty');
      return content;
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw new Error(`no reply within ${timeoutMs / 1000} seconds`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Tries a model call again when the service says it is too busy (HTTP 429) or fails on its side (5xx), waiting a little longer each time; any other failure is thrown at once. */
export function retryBusy(chat: Chat, options: { sleep?: (ms: number) => Promise<void>; waits?: number[] } = {}): Chat {
  const { sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)), waits = [2000, 5000, 10_000] } = options;
  return async (messages) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await chat(messages);
      } catch (error) {
        const busy = /HTTP (429|5\d\d)\b/.test((error as Error).message);
        if (!busy || attempt >= waits.length) throw error;
        await sleep(waits[attempt]!);
      }
    }
  };
}
