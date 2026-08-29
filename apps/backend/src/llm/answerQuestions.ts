import {
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
import { MODELS } from './client.js';
import { groundingContext, jobContext, sanitizeXmlContent } from './promptContext.js';
import { callStructured } from './structuredCall.js';

/**
 * Wraps `QuestionAnswer[]` in an object, since the forced tool call needs a top-level object shape.
 *
 * `question` is omitted from what the model returns. `reconcileAnswers` keys on `fieldId` and takes
 * the question text from the authoritative input — it has never read the model's copy — so asking
 * for it bought nothing and cost output tokens on every answer, which is the one thing this
 * operation's latency is made of. Measured at ~16% of the output tokens per call.
 */
const AnswerQuestionsOutputSchema = z.object({
  /**
   * `answer` is **required**. It was optional while this operation sent one call for the whole
   * form, where a missing answer had to cost one item rather than discard its valid siblings.
   * Fanning out removed the siblings: one call answers one question, so an item without an answer
   * is the entire call having produced nothing.
   *
   * Leaving it optional was actively harmful once generation stopped being a forced tool call. A
   * live provider returned `{"fieldId":"q1","sourceStoryIds":[...]}` with no `answer`, which
   * validated, reconciled to nothing, and surfaced as a form the model had declined to answer
   * rather than as a failure. Required, the same omission is an `invalid-input` that says so.
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

    // A stated fact needs no model output to resolve, and never did: `matchKnownAnswer` is local
    // matching over this form's own options, and the draft the model used to return alongside it
    // was read for nothing but `sourceStoryIds` — which a stated fact has none of. Resolving it
    // here is what lets `answerQuestions` skip the call entirely.
    if (question.knownAnswer) {
      const answer = question.options ? matchKnownAnswer(question) : question.knownAnswer;
      return answer
        ? [{ fieldId: question.fieldId, question: question.question, answer, sourceStoryIds: [] }]
        : [];
    }

    const candidates = outputByFieldId.get(question.fieldId);
    if (candidates?.length !== 1) return [];

    const modelAnswer = candidates[0];
    if (!modelAnswer.answer?.trim()) return [];
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
 * How many questions may be in flight at once.
 *
 * One request per question is what makes this operation fast — the answers are written in parallel
 * instead of one after another — but it is also a burst of requests from a single candidate's single
 * click, and an application form with thirty questions should not become thirty simultaneous
 * requests. Eight covers the forms this runs against with room to spare; beyond it, questions go in
 * waves and the operation degrades to something slower rather than to something rate-limited.
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
      results[index] = await task(items[index]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_QUESTIONS, items.length) }, worker),
  );
  return results;
}

/**
 * The instructions and the Profile — everything that is identical for every question on the form.
 *
 * Kept apart from the per-question half so it can be sent as a cached prefix. The rules here are
 * about *how* to answer and are the same whichever question is being answered; the job, the
 * question and the rules that depend on the question live in {@link questionPrompt}.
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
 * Drafts answers to application questions, including freeform and choice questions, in the
 * candidate's voice.
 *
 * **One model call per question, run concurrently.** A single call had to write every answer in
 * sequence, and since a structured call spends its wall clock almost entirely on output tokens, its
 * latency grew linearly with the number of questions — six questions measured ~17s, which is the
 * whole Analysis Step waiting on the slowest of its three calls. Fanning out makes the operation
 * cost the *longest* answer instead of the sum of all of them: the same six measured ~4s. The
 * prompt never asked the model to consider the questions together — it picks stories per question,
 * by that question's own text — so there is no cross-question reasoning to lose.
 *
 * A question the Profile already answers (`knownAnswer`) is not sent at all. Its answer comes from
 * `matchKnownAnswer`, which is local matching; the model's draft for it was never read.
 *
 * @param profile - The Profile projection used for answers, including reusable `stories`.
 * @param jobInfo - The job being applied to, for context.
 * @param questions - The application questions to answer, in authoritative output order.
 * @returns Valid drafted answers in input-question order. A choice answer with no unambiguous
 *   matching option is omitted, so output count can be smaller than input count. Returns `[]`
 *   immediately (no API call) when `questions` is empty.
 * @throws The first call's error if *every* question's call failed — one failure is survivable and
 *   costs one answer, but a whole failed batch must not be reported as a form that needed none.
 */
export async function answerQuestions(
  profile: AnswerQuestionsProfile,
  jobInfo: JobInfo,
  questions: QuestionForModel[],
  signal?: AbortSignal,
): Promise<QuestionAnswer[]> {
  if (questions.length === 0) return [];

  const relevantProfile = {
    workExperience: profile.workExperience,
    education: profile.education,
    skills: profile.skills,
    stories: profile.stories,
    customAnswers: profile.customAnswers,
  };

  const toDraft = questions.filter((question) => !question.knownAnswer);
  if (toDraft.length === 0) return reconcileAnswers([], questions, profile);

  const cachedPrefix = sharedPrompt(relevantProfile);
  let firstFailure: unknown;
  const settled = await mapWithConcurrency(toDraft, async (question) => {
    try {
      const result = await callStructured({
        signal,
        model: MODELS.answerQuestions,
        // One answer, and a capped one. The old 4096 sized a whole form's worth of answers; leaving
        // it there would let a single runaway answer cost more wall clock than the entire form.
        maxTokens: 1024,
        toolName: 'report_answers',
        toolDescription: 'Report the drafted answer for the given application question.',
        schema: AnswerQuestionsOutputSchema,
        cachedPrefix,
        userContent: questionPrompt(jobInfo, question),
      });
      return result.answers;
    } catch (error) {
      // One question's failure costs one answer, not the form. The candidate reviews every drafted
      // answer anyway, and a missing one is visibly missing — where a thrown error takes down the
      // Analysis Step that the tailored resume and the fit report were also waiting on.
      //
      // An abandoned request is not one of those failures: every question aborts at once, and one
      // line each for a candidate closing the panel buries the real ones.
      if (!signal?.aborted) {
        console.warn('[djobi] answer_question_failed', {
          fieldId: question.fieldId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      firstFailure ??= error;
      return null;
    }
  });

  // Every question failing is not a form that needed no answers — it is the model or the provider
  // being unavailable, and it has to reach the caller as the failure it is. The first error is
  // rethrown rather than a summary of them: it carries the actual cause, and a `StructuredCallError`
  // keeps the kind and request id that `app.onError` logs.
  if (settled.every((answers) => answers === null)) throw firstFailure;

  return reconcileAnswers(
    settled.flatMap((answers) => answers ?? []),
    questions,
    profile,
  );
}
