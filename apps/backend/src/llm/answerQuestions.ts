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
import { MODEL } from './client.js';
import { groundingContext } from './promptContext.js';
import { callStructured } from './structuredCall.js';

/** Wraps `QuestionAnswer[]` in an object, since the forced tool call needs a top-level object shape. */
const AnswerQuestionsOutputSchema = z.object({
  // A missing answer makes only that item unusable; it must not discard otherwise valid siblings.
  answers: z.array(QuestionAnswerSchema.extend({ answer: z.string().optional() })),
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
    const candidates = outputByFieldId.get(question.fieldId);
    if (candidates?.length !== 1) return [];

    const modelAnswer = candidates[0];
    let answer: string | undefined;
    if (question.knownAnswer) {
      answer = question.options ? matchKnownAnswer(question) : question.knownAnswer;
    } else if (modelAnswer.answer?.trim()) {
      answer = question.options
        ? matchOptionLabel(question.options, modelAnswer.answer)
        : modelAnswer.answer;
    }
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
 * Drafts answers to application questions, including freeform and choice questions, in the
 * candidate's voice.
 *
 * @param profile - The Profile projection used for answers, including reusable `stories`.
 * @param jobInfo - The job being applied to, for context.
 * @param questions - The application questions to answer, in authoritative output order.
 * @returns Valid drafted answers in input-question order. A choice answer with no unambiguous matching option
 *   is omitted, so output count can be smaller than input count. Returns `[]` immediately (no API
 *   call) when `questions` is empty.
 * @throws If the model doesn't return a tool call, or returns one that fails validation.
 */
export async function answerQuestions(
  profile: AnswerQuestionsProfile,
  jobInfo: JobInfo,
  questions: QuestionForModel[],
): Promise<QuestionAnswer[]> {
  if (questions.length === 0) return [];

  const relevantProfile = {
    workExperience: profile.workExperience,
    education: profile.education,
    skills: profile.skills,
    stories: profile.stories,
  };

  const result = await callStructured({
    model: MODEL,
    maxTokens: 4096,
    toolName: 'report_answers',
    toolDescription: 'Report the drafted answers for the given application questions.',
    schema: AnswerQuestionsOutputSchema,
    userContent: `Draft answers to the following job application questions, written in the candidate's voice as implied by their profile. Ground every answer in the candidate's actual work experience and stories — pick the 1-3 most relevant stories per question by matching the question against each story's tags and content, and set sourceStoryIds accordingly (empty array if no story fits and you drew on general profile info instead). Do not fabricate experience not present in the profile. Keep answers concise and concrete — prefer specific outcomes over generic claims.

${groundingContext(relevantProfile, jobInfo)}

<questions>
${JSON.stringify(questions)}
</questions>

If a question includes an "options" array, your answer MUST be copied verbatim from one of the provided options — do not invent or rephrase.

If a question includes a "knownAnswer", that is the candidate's own stated answer to this question, taken from their profile. It is a fact, not a suggestion: your answer MUST express the same thing. Your only job there is to say it in this form's words — pick the option that means what knownAnswer says, and never the opposite one. If no option means that, return no answer for that question rather than one that contradicts it. These are legal declarations about work authorization, sponsorship and similar; an answer that reverses the candidate's stated position is worse than no answer at all.

Return one answer per question, in the same order, with fieldId copied from the input question.`,
  });

  return reconcileAnswers(result.answers, questions, profile);
}
