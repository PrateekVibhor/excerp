import { INTERESTS, type Quiz, type QuizQuestion } from '../../src/data/types.ts';
import { extractJson, type Chat, type ChatMessage } from './llm.ts';

export const QUESTIONS_PER_QUIZ = 3;
export const OPTIONS_PER_QUESTION = 4;
export const MAX_PROMPT_CHARS = 140;
export const MAX_OPTION_CHARS = 80;
/** The right option may be at most this many times as long as the longest wrong one, or it gives itself away. */
export const MAX_LENGTH_RATIO = 1.5;
/** A short answer ("4.8" next to "5") is not a giveaway however the ratio looks, so the gap must also be this many characters. */
export const MIN_LENGTH_GAP = 8;

export interface QuizResult {
  quiz: Quiz;
  /** One of the interest topics, or null when the model named anything else. */
  topic: string | null;
}

export type QuizValidation = { ok: true; value: QuizResult } | { ok: false; reason: string };

/** A question reads as if about the article itself, so it must not point at the text it came from. */
const REFERS_TO_SOURCE = /\bthe summary\b|\baccording to\b/i;

/** Two options sharing at least this share of their words (Jaccard) count as the same option with a word changed. */
export const NEAR_DUPLICATE_SIMILARITY = 0.75;
/** The same, compared word by word in order: 1 - (words to change, add or drop) / (words in the longer option). */
export const NEAR_DUPLICATE_ORDER_SIMILARITY = 0.75;
/** Shorter options are not compared: with two or three words, sharing most of them says little. */
export const NEAR_DUPLICATE_MIN_WORDS = 4;

const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'to', 'and', 'or', 'in', 'on', 'by', 'for', 'with', 'as', 'at', 'from', 'is', 'are', 'was', 'were', 'it', 'its', 'that', 'this', 'only', 'both', 'all', 'no', 'none', 'not']);

/** Lower-case words and numbers, without punctuation. */
export const wordsOf = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Share of words two texts have in common: 1 for the same words, 0 for none. */
export function wordOverlap(a: string, b: string): number {
  const x = new Set(wordsOf(a));
  const y = new Set(wordsOf(b));
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const word of x) if (y.has(word)) shared++;
  return shared / (x.size + y.size - shared);
}

/** How alike two texts are as sequences of words: 1 for the same words in the same order, lower the more must change. */
export function wordOrderSimilarity(a: string, b: string): number {
  const x = wordsOf(a);
  const y = wordsOf(b);
  const longer = Math.max(x.length, y.length);
  if (longer === 0) return 0;
  // Edit distance over words: one change, insertion or deletion costs 1.
  let previous = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    previous = row;
  }
  return 1 - previous[y.length] / longer;
}

/**
 * Pairs of options (0-based positions) that are the same words with one or two changed: they share most of their
 * words, and those words sit in the same order. Options that reuse the words in another order, such as two parts
 * swapped between two things, are different answers and are not paired.
 */
export function findNearDuplicates(options: string[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < options.length; i++) {
    for (let j = i + 1; j < options.length; j++) {
      if (wordsOf(options[i]).length < NEAR_DUPLICATE_MIN_WORDS || wordsOf(options[j]).length < NEAR_DUPLICATE_MIN_WORDS) continue;
      if (wordOverlap(options[i], options[j]) >= NEAR_DUPLICATE_SIMILARITY && wordOrderSimilarity(options[i], options[j]) >= NEAR_DUPLICATE_ORDER_SIMILARITY) pairs.push([i, j]);
    }
  }
  return pairs;
}

export interface AnswerLeak {
  /** The question whose right answer is repeated (0-based). */
  answer: number;
  /** The question that repeats it, in its prompt or in its right answer (0-based). */
  repeatedIn: number;
  where: 'prompt' | 'right answer';
  text: string;
}

const containsRun = (haystack: string[], needle: string[]) => {
  for (let i = 0; i + needle.length <= haystack.length; i++) if (needle.every((word, k) => haystack[i + k] === word)) return true;
  return false;
};

/**
 * Right answers that another question repeats. If question 2's prompt, or question 2's own right answer, contains
 * the right answer to question 1 word for word, the reader is told the answer by the quiz itself. Answers need two
 * real words, or one of five letters or more, to count: "65%" turning up again is not a leak.
 */
export function findAnswerLeaks(quiz: Quiz): AnswerLeak[] {
  const leaks: AnswerLeak[] = [];
  for (const [q, question] of quiz.questions.entries()) {
    const answer = clean(question.options[question.correct_index]);
    const words = wordsOf(answer);
    const content = words.filter((w) => !STOPWORDS.has(w));
    if (!(content.length >= 2 || (content.length === 1 && content[0].length >= 5))) continue;
    for (const [r, other] of quiz.questions.entries()) {
      if (r === q) continue;
      if (containsRun(wordsOf(other.prompt), words)) leaks.push({ answer: q, repeatedIn: r, where: 'prompt', text: answer });
      else if (containsRun(wordsOf(other.options[other.correct_index]), words)) leaks.push({ answer: q, repeatedIn: r, where: 'right answer', text: answer });
    }
  }
  return leaks;
}

const clean = (text: unknown): string => (typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '');

function validateQuestion(raw: unknown, n: number): { ok: true; value: QuizQuestion } | { ok: false; reason: string } {
  const at = `question ${n}`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: `${at} is not an object` };
  const { prompt: rawPrompt, options: rawOptions, correct_index } = raw as Record<string, unknown>;

  const prompt = clean(rawPrompt);
  if (prompt.length === 0) return { ok: false, reason: `${at} has no prompt` };
  if (prompt.length > MAX_PROMPT_CHARS) return { ok: false, reason: `${at} prompt has ${prompt.length} characters; the limit is ${MAX_PROMPT_CHARS}` };

  if (REFERS_TO_SOURCE.test(prompt)) return { ok: false, reason: `${at} prompt must not mention "the summary" or "according to"; ask the question directly` };

  if (!Array.isArray(rawOptions) || rawOptions.length !== OPTIONS_PER_QUESTION) {
    return { ok: false, reason: `${at} must have exactly ${OPTIONS_PER_QUESTION} options` };
  }
  const options = rawOptions.map(clean);
  for (const option of options) {
    if (option.length === 0) return { ok: false, reason: `${at} has an empty option` };
    if (option.length > MAX_OPTION_CHARS) return { ok: false, reason: `${at} has an option of ${option.length} characters; the limit is ${MAX_OPTION_CHARS}` };
  }
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return { ok: false, reason: `${at} has two identical options` };
  const [similar] = findNearDuplicates(options);
  if (similar) return { ok: false, reason: `${at} has options ${LETTERS[similar[0]]} and ${LETTERS[similar[1]]} that are nearly the same words; make the four options clearly different` };

  if (!Number.isInteger(correct_index) || (correct_index as number) < 0 || (correct_index as number) >= OPTIONS_PER_QUESTION) {
    return { ok: false, reason: `${at} correct_index must be a whole number from 0 to ${OPTIONS_PER_QUESTION - 1}` };
  }
  const right = options[correct_index as number].length;
  const longestWrong = Math.max(...options.filter((_, i) => i !== correct_index).map((o) => o.length));
  if (right > MAX_LENGTH_RATIO * longestWrong && right - longestWrong >= MIN_LENGTH_GAP) {
    return { ok: false, reason: `${at} has a right answer of ${right} characters but no wrong answer longer than ${longestWrong}; make the four options about the same length` };
  }
  return { ok: true, value: { prompt, options, correct_index: correct_index as number } };
}

/**
 * Checks a parsed model reply: `{ questions: [...3], topic }`. A bad quiz is rejected with a reason
 * the model can be told; a topic outside the interest list is not a reason to reject, it becomes null.
 */
export function validateQuiz(raw: unknown): QuizValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'reply is not a JSON object' };
  const { questions, topic } = raw as Record<string, unknown>;
  if (!Array.isArray(questions) || questions.length !== QUESTIONS_PER_QUIZ) {
    return { ok: false, reason: `quiz must have exactly ${QUESTIONS_PER_QUIZ} questions` };
  }
  const checked: QuizQuestion[] = [];
  for (const [i, q] of questions.entries()) {
    const result = validateQuestion(q, i + 1);
    if (!result.ok) return result;
    checked.push(result.value);
  }
  const [leak] = findAnswerLeaks({ questions: checked });
  if (leak) {
    return { ok: false, reason: `question ${leak.repeatedIn + 1} ${leak.where === 'prompt' ? 'asks with' : 'answers with'} the right answer to question ${leak.answer + 1} ("${leak.text}"); make each question about a different point and do not reuse another question's answer` };
  }
  const wanted = clean(topic).toLowerCase();
  return { ok: true, value: { quiz: { questions: checked }, topic: INTERESTS.find((t) => t.toLowerCase() === wanted) ?? null } };
}

/** Finds the JSON in a raw model reply and validates it. Never throws. */
export function parseQuiz(reply: string): QuizValidation {
  let raw: unknown;
  try {
    raw = extractJson(reply);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  return validateQuiz(raw);
}

/** The instructions for the model. It sees the summary and nothing else, so it cannot ask about anything beyond it. */
export function quizSystemPrompt(): string {
  const topics = INTERESTS.map((t) => `"${t}"`).join(', ');
  return [
    'You write a short quiz for a reading app. The reader has just read the SUMMARY given below and nothing else.',
    'Reply with one JSON object and nothing else:',
    `{"topic": one of ${topics}, "questions": [{"prompt": string, "options": [string, string, string, string], "correct_index": 0 to 3}, ...]}.`,
    `Write exactly ${QUESTIONS_PER_QUIZ} questions, one for each of three different key points of the summary.`,
    'Use only what the summary says: the right answer and the point of every question must come from it. Never ask about the article beyond it.',
    'Write each question as a plain question about the subject. Never write "the summary", "the text", "the article" or "according to".',
    'Each question must draw on a different part of the text, and no question may give away or reuse the answer to another.',
    `Each question has exactly ${OPTIONS_PER_QUESTION} different options and exactly one is correct, as the summary shows.`,
    'The three wrong options must be plausible and of the same kind as the right one (another number, name, reason or approach) but clearly wrong for what the text says.',
    'Do not build the options of different questions from the same few figures or phrases, and do not use obviously silly options.',
    'Give the four options of a question about the same length and level of detail, so the right one cannot be spotted by being longer or more complete than the others: write the wrong options as full phrases of similar length, not short fragments.',
    `Keep each prompt under ${MAX_PROMPT_CHARS} characters and each option under ${MAX_OPTION_CHARS}. Do not use "all of the above" or "none of the above".`,
    'Put the correct answer at a different position in different questions.',
    'topic is the single interest topic that fits the summary best.',
  ].join(' ');
}

/** Only the summary is sent: the full article text is never stored, so the quiz cannot depend on it. */
export function buildQuizMessages(summary: string): ChatMessage[] {
  return [
    { role: 'system', content: quizSystemPrompt() },
    { role: 'user', content: `SUMMARY:\n${summary.trim()}` },
  ];
}

const LETTERS = ['A', 'B', 'C', 'D'] as const;

/** The instructions for the checking pass. The checker is not told which answers are marked right. */
export function verifySystemPrompt(): string {
  return [
    'You check a quiz for a reading app. You are given a SUMMARY and three multiple-choice questions about it.',
    'For each question, list the letters of every option that the SUMMARY clearly supports as a correct answer.',
    'Use only the summary: an option is supported only if the summary says it or directly implies it. Do not use outside knowledge.',
    'A question can have one supported option, several, or none.',
    'Reply with one JSON object and nothing else: {"supported": [["B"], ["A", "C"], ["D"]]}, one list per question, in order.',
  ].join(' ');
}

/** The summary and the questions, with the options lettered and the answer key left out. */
export function buildVerifyMessages(summary: string, quiz: Quiz): ChatMessage[] {
  const questions = quiz.questions
    .map((q, i) => [`${i + 1}. ${q.prompt}`, ...q.options.map((o, k) => `   ${LETTERS[k]}) ${o}`)].join('\n'))
    .join('\n\n');
  return [
    { role: 'system', content: verifySystemPrompt() },
    { role: 'user', content: `SUMMARY:\n${summary.trim()}\n\nQUESTIONS:\n${questions}` },
  ];
}

export type Verification = { ok: true } | { ok: false; reason: string };

const joinLetters = (indexes: number[]) => indexes.map((i) => LETTERS[i]).join(' and ');

/** Reads the checker's reply: three lists of option letters. Throws a readable error when it is not that. */
export function parseSupported(reply: string): number[][] {
  const raw = extractJson(reply) as { supported?: unknown };
  if (!Array.isArray(raw.supported) || raw.supported.length !== QUESTIONS_PER_QUIZ) throw new Error(`the check must list ${QUESTIONS_PER_QUIZ} answers`);
  return raw.supported.map((entry, q) => {
    if (!Array.isArray(entry)) throw new Error(`the check for question ${q + 1} is not a list`);
    const indexes = entry.map((letter) => LETTERS.indexOf(String(letter).trim().toUpperCase() as (typeof LETTERS)[number]));
    if (indexes.some((i) => i < 0)) throw new Error(`the check for question ${q + 1} has a letter that is not A to D`);
    return [...new Set(indexes)].sort();
  });
}

/** Compares what the checker found in the summary with the quiz's own answers. */
export function compareWithKey(quiz: Quiz, supported: number[][]): Verification {
  for (const [q, question] of quiz.questions.entries()) {
    const found = supported[q];
    const marked = question.correct_index;
    if (found.length === 1 && found[0] === marked) continue;
    if (found.length === 0) return { ok: false, reason: `question ${q + 1}: the summary does not support any option, and ${LETTERS[marked]} is marked right; ask about something the summary says` };
    if (found.includes(marked)) return { ok: false, reason: `question ${q + 1}: the summary supports ${joinLetters(found)}, but only ${LETTERS[marked]} is marked right; make exactly one option correct` };
    return { ok: false, reason: `question ${q + 1}: the summary supports ${joinLetters(found)}, but ${LETTERS[marked]} is marked right` };
  }
  return { ok: true };
}

/** Asks the model to answer the quiz from the summary alone, and checks that it agrees with the quiz's own answers. */
export async function verifyQuiz(summary: string, quiz: Quiz, chat: Chat): Promise<Verification> {
  let supported: number[][];
  try {
    supported = parseSupported(await chat(buildVerifyMessages(summary, quiz)));
  } catch (error) {
    return { ok: false, reason: `quiz check failed: ${(error as Error).message}` };
  }
  return compareWithKey(quiz, supported);
}

export type QuizGeneration =
  | { ok: true; value: QuizResult; attempts: number; failures: string[] }
  | { ok: false; reason: string; attempts: number; failures: string[] };

export interface QuizOptions {
  /** Retries after the first attempt, as for the summary. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  retryDelayMs?: number;
  /** Have the model answer the quiz from the summary before accepting it. On by default; only tests switch it off. */
  verify?: boolean;
  /** Told about every attempt that did not give a usable quiz, with its reason. */
  log?: (event: { event: 'quiz_attempt_failed'; attempt: number; reason: string }) => void;
}

/**
 * Asks the model for a quiz about a summary, validating every reply. An invalid reply or a failed
 * call is retried, telling the model what was wrong. Never throws: after the last attempt it returns
 * the reasons, so the article can be stored without a quiz.
 */
export async function generateQuiz(summary: string, chat: Chat, options: QuizOptions = {}): Promise<QuizGeneration> {
  const { retries = 2, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retryDelayMs = 1000, verify = true, log } = options;
  const messages = buildQuizMessages(summary);
  const failures: string[] = [];
  let reason = 'no attempt was made';
  const fail = (attempt: number, why: string) => {
    reason = why;
    failures.push(why);
    log?.({ event: 'quiz_attempt_failed', attempt, reason: why });
  };

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    if (attempt > 1) await sleep(retryDelayMs * (attempt - 1));
    let reply: string;
    try {
      reply = await chat(messages);
    } catch (error) {
      fail(attempt, `model call failed: ${(error as Error).message}`);
      continue;
    }
    const result = parseQuiz(reply);
    if (result.ok) {
      const check = verify ? await verifyQuiz(summary, result.value.quiz, chat) : ({ ok: true } as const);
      if (check.ok) return { ok: true, value: result.value, attempts: attempt, failures };
      fail(attempt, check.reason);
      messages.push({ role: 'assistant', content: reply }, { role: 'user', content: `That was not usable: ${check.reason}. Try again and reply with the JSON object only.` });
      continue;
    }
    fail(attempt, result.reason);
    messages.push({ role: 'assistant', content: reply }, { role: 'user', content: `That was not usable: ${result.reason}. Try again and reply with the JSON object only.` });
  }
  return { ok: false, reason, attempts: retries + 1, failures };
}
