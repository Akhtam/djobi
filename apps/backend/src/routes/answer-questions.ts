import { JobInfoSchema, ProfileSchema } from '@djobi/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { answerQuestions } from '../llm/answerQuestions.js';

const QuestionToAnswerSchema = z.object({
  fieldId: z.string(),
  question: z.string(),
});

const AnswerQuestionsBodySchema = z.object({
  profile: ProfileSchema,
  jobInfo: JobInfoSchema,
  questions: z.array(QuestionToAnswerSchema),
});

/** `POST /answer-questions` — drafts answers to a set of freeform application questions. */
export const answerQuestionsRoute = new Hono();

answerQuestionsRoute.post('/answer-questions', async (c) => {
  const body = await c.req.json();
  const parsed = AnswerQuestionsBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message }, 400);
  }

  const { profile, jobInfo, questions } = parsed.data;
  const answers = await answerQuestions(profile, jobInfo, questions);
  return c.json(answers);
});
