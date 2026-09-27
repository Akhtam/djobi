import {
  AnswerQuestionsProfileSchema,
  failureMessage,
  matchPreparedAnswerToOption,
  matchOptionLabel,
  matchScreeningTopic,
  normalizeLabel,
  QuestionAnswerSchema,
  uniqueMatch,
  type AnswerQuestionsProfile,
  type JobInfo,
  type QuestionAnswer,
  type QuestionForModel,
} from '@djobi/shared';
import { z } from 'zod';
import { groundingContext, jobContext, sanitizeXmlContent } from './promptContext.js';
import { callStructured } from './structuredCall.js';

/**
 * The model's output: answers without `question` (reconciliation takes it from the input by
 * `fieldId`, and omitting it saves output tokens).
 */
const AnswerQuestionsOutputSchema = z.object({
  /**
   * `answer` is required: each call answers one question, so an answer-less item means the call
   * produced nothing and should fail as `invalid-input`, not pass silently.
   */
  answers: z.array(QuestionAnswerSchema.omit({ question: true })),
});

type ModelQuestionAnswer = z.infer<typeof AnswerQuestionsOutputSchema>['answers'][number];

type Polarity = 'yes' | 'no';

function polarityOf(text: string): Polarity | undefined {
  const normalized = normalizeLabel(text);
  if (/^yes(?:\b|[^a-z0-9])/.test(normalized)) return 'yes';
  if (/^no(?:\b|[^a-z0-9])/.test(normalized)) return 'no';
  return undefined;
}

function topicOptionPolarity(question: string, option: string): Polarity | undefined {
  const explicit = polarityOf(option);
  if (explicit) return explicit;

  const normalized = normalizeLabel(option);
  const topic = matchScreeningTopic(question);
  if (topic === 'work_authorization') {
    const authorizationConcept =
      '(?:authori[sz]ed|eligible|have (?:the )?(?:legal )?right to work)';
    if (
      /\b(?:unauthori[sz]ed|ineligible|(?:no|without) (?:work )?authori[sz]ation|(?:do not|don't|does not|doesn't) have (?:work )?authori[sz]ation|no (?:legal )?right to work|cannot work|can't work)\b/.test(
        normalized,
      ) ||
      new RegExp(
        `\\b(?:not|never|isn't|aren't|is not|are not)\\b(?:\\s+\\w+){0,3}\\s+${authorizationConcept}\\b`,
      ).test(normalized)
    )
      return 'no';
    if (!/(authori[sz]|eligible|right to work)/.test(normalized)) return undefined;
    return 'yes';
  }

  if (topic === 'sponsorship_required') {
    if (!/sponsor/.test(normalized) || !/(requir|need)/.test(normalized)) return undefined;
    return /\b(?:no|not|don't|doesn't|won't|wouldn't|cannot|can't)\b/.test(normalized)
      ? 'no'
      : 'yes';
  }

  return undefined;
}

/** Resolves a stated profile fact to exactly one form option, declining any ambiguous inference. */
function matchKnownAnswer(question: QuestionForModel): string | undefined {
  if (!question.knownAnswer || !question.options) return undefined;

  const direct = matchPreparedAnswerToOption(question.options, question.knownAnswer);
  if (direct) return direct;

  const polarity = polarityOf(question.knownAnswer);
  if (!polarity) return undefined;
  return uniqueMatch(
    question.options,
    (option) => topicOptionPolarity(question.question, option) === polarity,
  );
}

/** Rejoins untrusted model output to the authoritative questions and profile. */
function reconcileAnswers(
  answers: ModelQuestionAnswer[],
  questions: QuestionForModel[],
  profile: AnswerQuestionsProfile,
): QuestionAnswer[] {
  const inputCounts = new Map<string, number>();
  const outputByFieldId = new Map<string, ModelQuestionAnswer[]>();
  for (const question of questions)
    inputCounts.set(question.fieldId, (inputCounts.get(question.fieldId) ?? 0) + 1);
  for (const answer of answers) {
    const matches = outputByFieldId.get(answer.fieldId) ?? [];
    matches.push(answer);
    outputByFieldId.set(answer.fieldId, matches);
  }

  const storyIdCounts = new Map<string, number>();
  for (const story of profile.stories) {
    if (story.id.trim()) storyIdCounts.set(story.id, (storyIdCounts.get(story.id) ?? 0) + 1);
  }
  const storyIds = new Set([...storyIdCounts].flatMap(([id, count]) => (count === 1 ? [id] : [])));
  return questions.flatMap((question) => {
    if (inputCounts.get(question.fieldId) !== 1) return [];

    // A stated fact resolves by local matching over this form's options; no model call needed.
    if (question.knownAnswer) {
      const answer = question.options ? matchKnownAnswer(question) : question.knownAnswer;
      return answer
        ? [{ fieldId: question.fieldId, question: question.question, answer, sourceStoryIds: [] }]
        : [];
    }

    const candidates = outputByFieldId.get(question.fieldId);
    if (candidates?.length !== 1) return [];

    const modelAnswer = candidates[0];
    if (!modelAnswer?.answer?.trim()) return [];
    const answer = question.options
      ? matchOptionLabel(question.options, modelAnswer.answer)
      : modelAnswer.answer;
    if (!answer) return [];

    return [
      {
        fieldId: question.fieldId,
        question: question.question,
        answer,
        sourceStoryIds: [...new Set(modelAnswer.sourceStoryIds.filter((id) => storyIds.has(id)))],
      },
    ];
  });
}

/**
 * Questions in flight at once. One request per question keeps latency at the longest answer; the
 * cap stops a 30-question form becoming 30 simultaneous requests.
 */
const MAX_CONCURRENT_QUESTIONS = 8;

/** Runs `task` over `items`, at most {@link MAX_CONCURRENT_QUESTIONS} at a time, in input order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      // `index < items.length` was just checked, so the element exists.
      results[index] = await task(items[index]!);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_QUESTIONS, items.length) }, worker),
  );
  return results;
}

/**
 * Instructions and Profile — identical for every question — sent as a cacheable prefix. The job and
 * per-question rules are in {@link questionPrompt}.
 */
function sharedPrompt(profile: object): string {
  return `Draft the candidate's answer to one job application question, written in their own voice as implied by their profile. Ground the answer in the candidate's actual work experience and stories — pick the 1-3 most relevant stories by matching the question against each story's tags and content, and set sourceStoryIds accordingly (empty array if no story fits and you drew on general profile info instead). Do not fabricate experience not present in the profile.

Answer in the form the question asks for, and no larger. A question that asks for a yes or a no is answered with "Yes" or "No" — add at most one short clause after it if the profile makes one genuinely necessary, and nothing at all if it does not. A question asking for a name, a number, a date or a place is answered with that name, number, date or place. Only a question that actually asks the candidate to explain or describe something gets sentences.

When sentences are called for, write at most two. Be specific and concrete — one real detail from the profile beats any amount of general enthusiasm. Write the way the candidate would type it into the box: plain, direct, no throat-clearing, no restating the question back, no phrases like "I am excited to" or "I believe that". Never pad an answer to look thorough; a short true answer is the better answer.

${groundingContext(profile)}`;
}

/** The job, the one question, and the rules that depend on what that question carries. */
function questionPrompt(jobInfo: JobInfo, question: QuestionForModel): string {
  return `${jobContext(jobInfo)}

<question>
${sanitizeXmlContent(JSON.stringify(question))}
</question>

If the question includes an "options" array, your answer MUST be copied verbatim from one of the provided options — do not invent or rephrase.

If a prepared answer in base_profile.customAnswers asks about the same subject as this question, it is what the candidate has already decided to say about it — reuse its substance and its specifics, changing only what this form's wording requires. Never draft a second, different position beside one the candidate has already written. If none of them is about this question, ignore them and draft from the profile as usual.

Return exactly one answer, with fieldId copied from the question.`;
}

/**
 * Drafts answers to freeform and choice questions in the candidate's voice.
 *
 * One model call per question, run concurrently, so latency is the longest answer rather than the
 * sum (stories are picked per question, so nothing is lost). Questions with a `knownAnswer` are
 * resolved locally by `matchKnownAnswer` and never sent.
 *
 * @param profile - The Profile projection used for answers, including `stories`.
 * @param jobInfo - The job being applied to.
 * @param questions - The questions to answer, in output order.
 * @returns Answers in input order. A choice answer with no unambiguous option is omitted. `[]` with
 *   no API call when `questions` is empty.
 * @throws The first error if *every* call failed; individual failures just cost that answer.
 */
export async function answerQuestions(
  profile: AnswerQuestionsProfile,
  jobInfo: JobInfo,
  questions: QuestionForModel[],
  signal?: AbortSignal,
): Promise<QuestionAnswer[]> {
  if (questions.length === 0) return [];

  const toDraft = questions.filter((question) => !question.knownAnswer);
  if (toDraft.length === 0) return reconcileAnswers([], questions, profile);

  // The grounding projection, enforced rather than assumed — see `tailorResume.ts` for why a type
  // alone cannot do it. Parsed once for the whole batch, not once per question.
  const cachedPrefix = sharedPrompt(AnswerQuestionsProfileSchema.parse(profile));
  let firstFailure: unknown;
  const settled = await mapWithConcurrency(toDraft, async (question) => {
    try {
      const result = await callStructured({
        signal,
        operation: 'answerQuestions',
        toolName: 'report_answers',
        toolDescription: 'Report the drafted answer for the given application question.',
        schema: AnswerQuestionsOutputSchema,
        cachedPrefix,
        userContent: questionPrompt(jobInfo, question),
      });
      return result.answers;
    } catch (error) {
      // One failure costs one (visibly missing) answer, not the whole Analysis Step. Aborts aren't
      // logged: every question aborts at once when the candidate leaves.
      if (!signal?.aborted) {
        console.warn('[djobi] answer_question_failed', {
          fieldId: question.fieldId,
          error: failureMessage(error),
        });
      }
      firstFailure ??= error;
      return null;
    }
  });

  // All failing means the model or provider is down; rethrow the first error, which keeps the kind
  // and request id `app.onError` logs.
  if (settled.every((answers) => answers === null)) throw firstFailure;

  return reconcileAnswers(
    settled.flatMap((answers) => answers ?? []),
    questions,
    profile,
  );
}
