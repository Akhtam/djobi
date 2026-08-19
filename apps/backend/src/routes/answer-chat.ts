import { AnswerChatRequestSchema } from '@djobi/shared';
import { Hono } from 'hono';
import { parseBody } from '../requestBody.js';
import { answerChat } from '../llm/answerChat.js';

/**
 * `POST /answer-chat` — one turn of the Ask tab's conversation about a single application question.
 *
 * One route for both flows: a cold ask sends an empty thread and no draft, refining an existing
 * answer sends `currentAnswer` and the thread so far. The difference lives entirely in the body.
 */
export const answerChatRoute = new Hono();

answerChatRoute.post('/answer-chat', async (c) => {
  const parsed = await parseBody(c, AnswerChatRequestSchema);

  return c.json(await answerChat(parsed));
});
