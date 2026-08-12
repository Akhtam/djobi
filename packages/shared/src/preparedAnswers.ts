/**
 * Deciding, for each question on a form, whether the profile already answers it.
 *
 * Three outcomes, and the distinction between the last two is the whole point of this module:
 *
 * - **Resolved.** The profile holds the answer and it fits the field as-is (a free-text field, or a
 *   choice whose options the stored answer names unambiguously). It's used verbatim and the
 *   question never reaches the answer-drafting model.
 * - **Known but unmapped.** The profile holds the answer, but the field offers choices none of
 *   which it clearly names — "No" against options spelled "I do not require sponsorship now or in
 *   the future" / "I will require sponsorship". The fact is certain; only its *wording* is in
 *   question, so the question goes to the model carrying the fact as ground truth, to be mapped
 *   rather than decided.
 * - **Unknown.** The profile says nothing, so it's drafted as before.
 *
 * Lives in `@djobi/shared` because both sides need it: the extension splits the questions before
 * calling the backend, and the backend puts `knownAnswer` into the prompt.
 */
import { matchScreeningTopic, resolveAnswerOption, type CustomAnswer } from './screeningAnswers.js';
import { normalizeLabel } from './optionLabel.js';

/**
 * The prepared-answer half of a {@link Profile} — all this module needs of one.
 *
 * Both halves are optional, and every read below tolerates their absence. A `Profile` is supposed
 * to arrive parsed, with the schema's defaults applied, but it reaches here across process and
 * storage boundaries — a row written before these fields existed, a panel holding a profile it
 * fetched before an upgrade — and a missing key here used to abort the whole Analysis Step with
 * `Cannot read properties of undefined`. Having no prepared answers is a perfectly ordinary state;
 * it should mean every question goes to the model, not that nothing gets answered at all.
 */
export interface PreparedAnswerSource {
  screeningAnswers?: Partial<Record<string, string>>;
  customAnswers?: CustomAnswer[];
}

/** A question as detected on the page, before it's known who will answer it. */
export interface PendingQuestion {
  fieldId: string;
  question: string;
  options?: string[];
}

/** A question the profile already answers outright, with the exact text to fill in. */
export interface ResolvedQuestion extends PendingQuestion {
  answer: string;
}

/** A question for the model, carrying whatever the profile does know about it. */
export interface QuestionForModel extends PendingQuestion {
  /** A fact the answer must honor — present only when the profile knows it but couldn't map it. */
  knownAnswer?: string;
}

export interface SplitQuestions {
  resolved: ResolvedQuestion[];
  forModel: QuestionForModel[];
}

/**
 * A custom prepared answer for `question`, matched by normalized text containment in either
 * direction — a stored "Are you willing to relocate?" should answer a form's "Are you willing to
 * relocate for this role?" and vice versa.
 *
 * Ambiguity means no match, as everywhere else here: if two stored questions both look like this
 * one, which was meant is exactly what isn't known.
 */
function matchCustomAnswer(
  customAnswers: CustomAnswer[],
  question: string,
): CustomAnswer | undefined {
  const target = normalizeLabel(question);
  if (!target) return undefined;

  const matches = customAnswers.filter((candidate) => {
    const stored = normalizeLabel(candidate.question);
    return stored !== '' && (stored.includes(target) || target.includes(stored));
  });

  return matches.length === 1 ? matches[0] : undefined;
}

/** What the profile knows about `question`, from a screening topic first, then a custom answer. */
export function preparedAnswerFor(
  profile: PreparedAnswerSource,
  question: string,
): string | undefined {
  const topic = matchScreeningTopic(question);
  const fromTopic = topic ? profile.screeningAnswers?.[topic] : undefined;
  if (fromTopic) return fromTopic;

  return matchCustomAnswer(profile.customAnswers ?? [], question)?.answer;
}

/**
 * Splits detected questions into the ones the profile answers and the ones the model must draft.
 *
 * A question with no options takes its prepared answer verbatim. One *with* options only counts as
 * resolved if the stored answer names a single option — otherwise the answer would be text the
 * form has no way to accept.
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

    const option = resolveAnswerOption(question.options, prepared);
    if (option) resolved.push({ ...question, answer: option });
    else forModel.push({ ...question, knownAnswer: prepared });
  }

  return { resolved, forModel };
}
