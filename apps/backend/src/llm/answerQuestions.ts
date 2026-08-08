import {
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

/** JSON Schema mirror of {@link AnswerQuestionsOutputSchema} (see `structuredCall.ts`). */
const answerQuestionsInputSchema = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          fieldId: { type: 'string', description: 'Matches DetectedField.id' },
          question: { type: 'string' },
          answer: { type: 'string' },
          sourceStoryIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Story.id values this answer drew on, if any',
          },
        },
        required: ['fieldId', 'question', 'answer', 'sourceStoryIds'],
      },
    },
  },
  required: ['answers'],
} as const;

/** One detected freeform field to draft an answer for — a trimmed-down {@link DetectedField}. */
export interface QuestionToAnswer {
  fieldId: string;
  question: string;
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
    inputSchema: answerQuestionsInputSchema,
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

Return one answer per question, in the same order, with fieldId copied from the input question.`,
  });

  return result.answers;
}
