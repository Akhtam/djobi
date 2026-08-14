import { AnswerQuestionsRequestSchema } from '@djobi/shared';
import { Hono } from 'hono';
import { answerQuestions } from '../llm/answerQuestions.js';

/** `POST /answer-questions` — drafts answers to a set of freeform application questions. */
export const answerQuestionsRoute = new Hono();

answerQuestionsRoute.post('/answer-questions', async (c) => {
  const body = await c.req.json();
  const parsed = AnswerQuestionsRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message }, 400);
  }

  const { profile, jobInfo, questions } = parsed.data;
  console.log('QUESTIONS', questions);
  
  const answers = await answerQuestions(profile, jobInfo, questions);
  return c.json(answers);
});
