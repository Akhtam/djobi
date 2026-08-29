/**
 * One turn of the Ask tab's conversation about a single application question.
 *
 * Asking cold and refining an existing draft are the same conversation with a different starting
 * state, so they are the same function: what separates them is whether `currentAnswer` is set and
 * whether the thread already has turns. Nothing here branches on "which flow is this".
 *
 * The grounding is `answerQuestions`' grounding, deliberately — this must not become the one
 * surface where the model is allowed to invent experience the Profile doesn't have, and a chat is
 * exactly where that pressure shows up ("just say I led the migration"). The Profile, the job and
 * the question live in the scaffold turn, never in a message the candidate can rewrite.
 */
import type { AnswerChatRequest, AnswerChatResponse } from '@djobi/shared';
import { z } from 'zod';
import { MODELS } from './client.js';
import { groundingContext, sanitizeXmlContent } from './promptContext.js';
import { callStructured } from './structuredCall.js';

const AnswerChatOutputSchema = z.object({
  reply: z.string(),
  revisedAnswer: z.string().optional(),
});

/**
 * A cold ask has to come back with an answer: a reply alone renders an Ask tab whose one purpose —
 * producing an answer — visibly didn't happen, and the model omitting it is worth naming as a
 * failure rather than showing as an empty result.
 *
 * Stated as a `requires` rather than as a `.min(1)` on the schema, which is where it used to live.
 * Every other turn already treats an absent answer and an empty one as the same thing (see the
 * trim below), so the model has two ways to say "no answer here" and only one of them was survivable
 * on this path: the instructions tell it to leave `revisedAnswer` out when a turn is conversational,
 * a model that complies by sending `''` fails the schema, and a schema violation is classified
 * non-retryable — so a recoverable coin-flip reached the candidate as a 500. As a `requires` the
 * same turn gets the second attempt every other model misstep gets.
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
 * @param request - The whole validated `POST /answer-chat` body: the Profile projection, the
 *   question under discussion, the optional job and current draft, and the thread so far.
 * @returns The reply to show in the thread, and the answer to apply when the turn produced one.
 * @throws {StructuredCallError} If the model doesn't return a tool call, or returns one that fails
 *   validation — including a cold turn that came back without an answer, which is retried once
 *   before it is reported.
 */
export async function answerChat(
  request: AnswerChatRequest,
  signal?: AbortSignal,
): Promise<AnswerChatResponse> {
  const { profile, question, jobInfo, currentAnswer, messages } = request;

  const relevantProfile = {
    workExperience: profile.workExperience,
    education: profile.education,
    skills: profile.skills,
    stories: profile.stories,
    customAnswers: profile.customAnswers,
  };

  // A cold turn is one with nothing to build on: no draft under discussion and no thread behind it.
  const coldTurn = messages.length === 0 && !currentAnswer?.trim();

  const draftSection = currentAnswer?.trim()
    ? `\n\n<current_answer>\n${sanitizeXmlContent(currentAnswer)}\n</current_answer>\n\nThe candidate is refining the draft above. Unless they ask for something else, keep what already works and change only what they asked about.`
    : '';

  const coldSection = coldTurn
    ? '\n\nThere is no draft yet and the candidate has not said anything beyond asking. Write the answer, and set "revisedAnswer" — this turn has nothing else to show them.'
    : '';

  // The scaffold is the conversation's first user turn, so a thread that itself opens with the
  // candidate would put two user turns in a row — which the Messages API refuses. That opening
  // turn is folded into the scaffold instead. A thread opening with the assistant needs no folding:
  // it is a cold ask's continuation, whose opening user turn was this scaffold in an earlier call.
  const foldedOpener = messages[0]?.role === 'user' ? messages[0] : undefined;
  const rest = foldedOpener ? messages.slice(1) : messages;
  const conversationOpener = foldedOpener ? `\n\n${sanitizeXmlContent(foldedOpener.content)}` : '';

  const result = await callStructured({
    signal,
    model: MODELS.answerChat,
    maxTokens: 4096,
    toolName: 'report_chat_turn',
    toolDescription: 'Report your reply to the candidate, and the answer text when you wrote one.',
    schema: AnswerChatOutputSchema,
    ...(coldTurn ? { requires: coldTurnRequires } : {}),
    userContent: `${INSTRUCTIONS}

${groundingContext(relevantProfile, jobInfo)}

<question>
${sanitizeXmlContent(question)}
</question>${draftSection}${coldSection}${conversationOpener}`,
    followUpTurns: rest,
  });

  const revisedAnswer = result.revisedAnswer?.trim();
  return revisedAnswer ? { reply: result.reply, revisedAnswer } : { reply: result.reply };
}
