import {
  matchOptionLabel,
  QuestionAnswerSchema,
  type JobInfo,
  type Profile,
  type QuestionAnswer,
} from '@djobi/shared';
import { z } from 'zod';
import { MODELS } from './client.js';
import { callStructured } from './structuredCall.js';

/** Wraps `QuestionAnswer[]` in an object, since the forced tool call needs a top-level object shape. */
const AnswerQuestionsOutputSchema = z.object({
  answers: z.array(QuestionAnswerSchema),
});

/** One detected freeform field to draft an answer for — a trimmed-down {@link DetectedField}. */
export interface QuestionToAnswer {
  fieldId: string;
  question: string;
  /** Valid choices for a select/combobox/radiogroup/checkboxgroup question, if any. */
  options?: string[];
  /**
   * A fact from the candidate's profile that this answer must honor.
   *
   * Set by `splitPreparedQuestions` for a question the profile answers but whose stored wording
   * names none of this form's options unambiguously — "No" against options spelled "I do not
   * require sponsorship now or in the future" / "I will require sponsorship". The decision is
   * already made; only the mapping onto this form's wording is left, and getting that backwards on
   * a work-authorization declaration is a misrepresentation, so the prompt treats it as binding
   * rather than as context.
   */
  knownAnswer?: string;
}

/**
 * Enforces that a choice-question's answer is one of its `options` verbatim: corrects
 * case/whitespace-only mismatches to the exact option text, and drops answers that match no
 * option at all (rather than letting a bad LLM answer get force-fit into `fillForm`'s
 * option-matching logic later) — the prompt asks for this, but the model isn't guaranteed to
 * comply, so it's enforced here too.
 *
 * `matchOptionLabel` is the same rule `content/fillForm.ts` uses to find the element for an answer;
 * see `@djobi/shared`'s `optionLabel.ts` for why it has to be.
 */
function constrainToOptions(
  answers: QuestionAnswer[],
  questions: QuestionToAnswer[],
): QuestionAnswer[] {
  const optionsByFieldId = new Map(questions.map((q) => [q.fieldId, q.options]));

  return answers.flatMap((answer) => {
    const options = optionsByFieldId.get(answer.fieldId);
    if (!options) return [answer];

    const match = matchOptionLabel(options, answer.answer);
    return match ? [{ ...answer, answer: match }] : [];
  });
}

/**
 * Drafts answers to freeform application questions in the candidate's voice, using the writing
 * model (`MODELS.writing`) and drawing on `profile.stories` for concrete, grounded material.
 *
 * @param profile - The candidate's base profile, including reusable `stories`.
 * @param jobInfo - The job being applied to, for context.
 * @param questions - The freeform questions to answer, in the order answers should be returned.
 * @returns One {@link QuestionAnswer} per input question, in the same order. Returns `[]`
 *   immediately (no API call) when `questions` is empty.
 * @throws If the model doesn't return a tool call, or returns one that fails validation.
 */
export async function answerQuestions(
  profile: Profile,
  jobInfo: JobInfo,
  questions: QuestionToAnswer[],
): Promise<QuestionAnswer[]> {
  if (questions.length === 0) return [];

  const result = await callStructured({
    model: MODELS.writing,
    maxTokens: 4096,
    toolName: 'report_answers',
    toolDescription: 'Report the drafted answers for the given application questions.',
    schema: AnswerQuestionsOutputSchema,
    userContent: `Draft answers to the following job application questions, written in the candidate's voice as implied by their profile. Ground every answer in the candidate's actual work experience and stories — pick the 1-3 most relevant stories per question by matching the question against each story's tags and content, and set sourceStoryIds accordingly (empty array if no story fits and you drew on general profile info instead). Do not fabricate experience not present in the profile. Keep answers concise and concrete — prefer specific outcomes over generic claims.

<base_profile>
${JSON.stringify(profile, null, 2)}
</base_profile>

<job_info>
${JSON.stringify(jobInfo, null, 2)}
</job_info>

<questions>
${JSON.stringify(questions, null, 2)}
</questions>

If a question includes an "options" array, your answer MUST be copied verbatim from one of the provided options — do not invent or rephrase.

If a question includes a "knownAnswer", that is the candidate's own stated answer to this question, taken from their profile. It is a fact, not a suggestion: your answer MUST express the same thing. Your only job there is to say it in this form's words — pick the option that means what knownAnswer says, and never the opposite one. If no option means that, return no answer for that question rather than one that contradicts it. These are legal declarations about work authorization, sponsorship and similar; an answer that reverses the candidate's stated position is worse than no answer at all.

Return one answer per question, in the same order, with fieldId copied from the input question.`,
  });

  return constrainToOptions(result.answers, questions);
}
