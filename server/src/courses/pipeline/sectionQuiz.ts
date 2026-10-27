// Plan 16, phase 4, stage 13: a quiz for a section, using the existing quiz validation and verification (src/quiz.ts) with the section's chapter
// text standing in for the summary. Written, validated, checked against the text, rewritten once with the reason, never passed unverified.
import type { QuizQuestion } from '../../../../src/data/types.ts';
import type { Chat } from '../../llm.ts';
import { buildQuizMessages, buildVerifyMessages, compareWithKey, parseQuiz, parseSupported } from '../../quiz.ts';

export type SectionQuiz = { ok: true; questions: QuizQuestion[] } | { ok: false; reason: string };

export async function makeSectionQuiz(chat: Chat, sectionText: string): Promise<SectionQuiz> {
  const text = sectionText.slice(0, 8000);
  let feedback = '';
  let reason = 'no attempt was made';
  for (let attempt = 0; attempt < 2; attempt++) {
    let reply: string;
    try {
      const messages = buildQuizMessages(text);
      if (feedback) messages.push({ role: 'user', content: `Your last quiz was rejected: ${feedback}. Write the whole quiz again.` });
      reply = await chat(messages);
    } catch (error) {
      reason = `the model could not be reached (${(error as Error).message.slice(0, 120)})`;
      continue;
    }
    const parsed = parseQuiz(reply);
    if (!parsed.ok) { feedback = reason = parsed.reason; continue; }
    try {
      const verdict = compareWithKey(parsed.value.quiz, parseSupported(await chat(buildVerifyMessages(text, parsed.value.quiz))));
      if (verdict.ok) return { ok: true, questions: parsed.value.quiz.questions };
      feedback = reason = verdict.reason;
    } catch (error) {
      feedback = reason = `the check failed: ${(error as Error).message}`;
    }
  }
  return { ok: false, reason };
}
