/**
 * Decides, per form question, whether the Profile already answers it:
 *
 * - **Resolved** — the answer fits the field as-is; filled verbatim, never sent to the model.
 * - **Known but unmapped** — the fact is known but no option clearly names it (stored "No" vs.
 *   "I do not require sponsorship…"); sent to the model with the fact as `knownAnswer`, to map the
 *   wording, not decide it.
 * - **Unknown** — drafted by the model.
 *
 * Shared: the extension splits questions; the backend puts `knownAnswer` into the prompt.
 */
import { matchScreeningTopic, type CustomAnswer } from './screeningAnswers.js';
import {
  matchByOverlap,
  matchPreparedAnswerToOption,
  questionsMatch,
  uniqueMatch,
} from './labelMatching.js';
import type { PendingQuestion, QuestionForModel } from './wire.js';

/**
 * The prepared-answer half of a {@link Profile}. Both fields are optional and tolerated missing
 * (older rows, stale panels): no prepared answers just means every question goes to the model.
 */
export interface PreparedAnswerSource {
  screeningAnswers?: Partial<Record<string, string>>;
  customAnswers?: CustomAnswer[];
}

/**
 * A question the Profile answers outright. Filled straight into the page; never sent to the
 * backend.
 */
export interface ResolvedQuestion extends PendingQuestion {
  answer: string;
}

export interface SplitQuestions {
  resolved: ResolvedQuestion[];
  forModel: QuestionForModel[];
}

/**
 * What the Profile knows about `question`: a screening topic first, then a custom answer matched by
 * {@link questionsMatch}, then `matchByOverlap` for a conservative paraphrase.
 *
 * Screening topics use only {@link matchScreeningTopic}'s patterns — legal declarations like work
 * authorization are never decided by word overlap.
 */
export function preparedAnswerFor(
  profile: PreparedAnswerSource,
  question: string,
): string | undefined {
  const topic = matchScreeningTopic(question);
  const fromTopic = topic ? profile.screeningAnswers?.[topic] : undefined;
  if (fromTopic) return fromTopic;

  const customAnswers = profile.customAnswers ?? [];
  const questionOf = (stored: CustomAnswer): string => stored.question;
  const stored =
    uniqueMatch(customAnswers, (candidate) => questionsMatch(candidate.question, question)) ??
    matchByOverlap(customAnswers, questionOf, question);
  return stored?.answer;
}

/**
 * Splits questions into Profile-answered and model-drafted. A question with options is resolved
 * only if the stored answer names exactly one option.
 */
export function splitPreparedQuestions(
  profile: PreparedAnswerSource,
  questions: PendingQuestion[],
): SplitQuestions {
  const resolved: ResolvedQuestion[] = [];
  const forModel: QuestionForModel[] = [];

  for (const question of questions) {
    const prepared = preparedAnswerFor(profile, question.question);

    if (prepared === undefined) {
      forModel.push(question);
      continue;
    }

    if (!question.options?.length) {
      resolved.push({ ...question, answer: prepared });
      continue;
    }

    const option = matchPreparedAnswerToOption(question.options, prepared);
    if (option) resolved.push({ ...question, answer: option });
    else forModel.push({ ...question, knownAnswer: prepared });
  }

  return { resolved, forModel };
}
