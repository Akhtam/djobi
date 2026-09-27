/**
 * One turn of the Ask tab's conversation about one application question. Cold asks and refinements
 * are the same function; they differ only in `currentAnswer` and the thread.
 *
 * Grounding matches `answerQuestions` so chat can't become a way to invent experience. The Profile,
 * job and question live in the scaffold turn, never in a message the candidate can rewrite.
 */
import {
  AnswerChatProfileSchema,
  type AnswerChatRequest,
  type AnswerChatResponse,
} from '@djobi/shared';
import { z } from 'zod';
import { groundingContext, sanitizeXmlContent } from './promptContext.js';
import { callStructured } from './structuredCall.js';

const AnswerChatOutputSchema = z.object({
  reply: z.string(),
  revisedAnswer: z.string().optional(),
});

/**
 * A cold ask must return an answer. A `requires` rather than `.min(1)`: a schema violation is not
 * retried, but an empty `revisedAnswer` is a coin flip worth a second attempt.
 */
function coldTurnRequires(value: z.infer<typeof AnswerChatOutputSchema>): string | undefined {
  return value.revisedAnswer?.trim() ? undefined : 'revisedAnswer required';
}

/** How the model is told to behave, once. The rules are the same on every turn of every thread. */
const INSTRUCTIONS = `You are helping a job candidate write their answer to one application question. You are talking to the candidate, in a conversation about that answer.

Ground everything in the candidate's profile below. Never invent experience, employers, achievements, or skills that are not in it — not even if the candidate asks you to. If they ask for something the profile does not support, say so in your reply and offer what the profile does support instead.

Write answers in the candidate's own voice as implied by their profile, concise and concrete, preferring specific outcomes over generic claims.

If a prepared answer in base_profile.customAnswers is about the question under discussion, the candidate has already decided what they say about it — build on that answer rather than writing a different one beside it, and keep its specifics unless the candidate asks you to change them.

Keep "reply" to at most two sentences by default: precise, plain, no preamble, no restating what you just wrote in "revisedAnswer". Go longer only when the candidate explicitly asks for more — for detail, for options, for an explanation. This is a limit on your side of the conversation only; the answer itself in "revisedAnswer" is as long as the question needs.

Return your side of the conversation as "reply", and — whenever you have produced or updated the answer itself — the full answer text as "revisedAnswer". "revisedAnswer" is what the candidate applies to their application, so it must be the complete answer on its own, not a fragment or a description of what changed. Leave it out when the turn is purely conversational, such as when you are asking the candidate which of two directions they want.`;

/**
 * Answers one turn of a chat about an application question.
 *
 * @param request - The validated `POST /answer-chat` body.
 * @returns The reply to show, and the revised answer when the turn produced one.
 * @throws {StructuredCallError} If the model returns no valid object — including a cold turn with
 *   no answer, after one retry.
 */
export async function answerChat(
  request: AnswerChatRequest,
  signal?: AbortSignal,
): Promise<AnswerChatResponse> {
  const { profile, question, jobInfo, currentAnswer, messages } = request;

  // A cold turn is one with nothing to build on: no draft under discussion and no thread behind it.
  const coldTurn = messages.length === 0 && !currentAnswer?.trim();

  const draftSection = currentAnswer?.trim()
    ? `\n\n<current_answer>\n${sanitizeXmlContent(currentAnswer)}\n</current_answer>\n\nThe candidate is refining the draft above. Unless they ask for something else, keep what already works and change only what they asked about.`
    : '';

  const coldSection = coldTurn
    ? '\n\nThere is no draft yet and the candidate has not said anything beyond asking. Write the answer, and set "revisedAnswer" — this turn has nothing else to show them.'
    : '';

  // The scaffold is the first user turn, so a thread opening with the candidate is folded into it
  // (two consecutive user turns are rejected). A thread opening with the assistant needs no
  // folding.
  const foldedOpener = messages[0]?.role === 'user' ? messages[0] : undefined;
  const rest = foldedOpener ? messages.slice(1) : messages;
  const conversationOpener = foldedOpener ? `\n\n${sanitizeXmlContent(foldedOpener.content)}` : '';

  const result = await callStructured({
    signal,
    operation: 'answerChat',
    toolName: 'report_chat_turn',
    toolDescription: 'Report your reply to the candidate, and the answer text when you wrote one.',
    schema: AnswerChatOutputSchema,
    ...(coldTurn ? { requires: coldTurnRequires } : {}),
    userContent: `${INSTRUCTIONS}

${groundingContext(AnswerChatProfileSchema.parse(profile), jobInfo)}

<question>
${sanitizeXmlContent(question)}
</question>${draftSection}${coldSection}${conversationOpener}`,
    followUpTurns: rest,
  });

  const revisedAnswer = result.revisedAnswer?.trim();
  return revisedAnswer ? { reply: result.reply, revisedAnswer } : { reply: result.reply };
}
