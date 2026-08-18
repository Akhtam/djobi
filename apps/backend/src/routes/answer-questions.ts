import { AnswerQuestionsRequestSchema } from '@djobi/shared';
import { Hono } from 'hono';
import { parseBody } from '../requestBody.js';
import { answerQuestions } from '../llm/answerQuestions.js';

/** `POST /answer-questions` — drafts answers to a set of freeform application questions. */
export const answerQuestionsRoute = new Hono();

answerQuestionsRoute.post('/answer-questions', async (c) => {
  const parsed = await parseBody(c, AnswerQuestionsRequestSchema);

  const { profile, jobInfo, questions } = parsed;

  const answers = await answerQuestions(profile, jobInfo, questions);
  return c.json(answers);
});
