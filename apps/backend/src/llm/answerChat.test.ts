import type { AnswerChatRequest, JobInfo } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockDoGenerate, modelCall, objectGeneration, openrouter } from './fakeModel.js';
import { routeFor } from './routing.js';

vi.mock('./client.js', () => import('./fakeModel.js'));

const { answerChat } = await import('./answerChat.js');
const { StructuredCallError } = await import('./structuredCall.js');

const profile: AnswerChatRequest['profile'] = {
  workExperience: [
    {
      company: 'Northwind',
      title: 'Software Engineer',
      startDate: '2021-06',
      endDate: null,
      bullets: ['Built the billing portal.'],
    },
  ],
  education: [],
  skills: ['TypeScript'],
  stories: [],
};

const jobInfo: JobInfo = {
  company: 'Acme',
  team: 'Platform',
  roleTitle: 'Senior Software Engineer',
  seniority: 'Senior',
  location: 'Remote',
  requirements: ['5+ years of backend experience'],
  keywords: ['TypeScript'],
};

/** The request body as sent, minus whatever a test is making a point about. */
function request(overrides: Partial<AnswerChatRequest> = {}): AnswerChatRequest {
  return { profile, question: 'Why do you want to work here?', messages: [], ...overrides };
}

/**
 * The conversation turns sent on the most recent call, each flattened back to a plain string.
 *
 * A turn's content reaches the provider as an array of parts; whether a given turn becomes one part
 * or several is the SDK's business, and what the model reads is the concatenation. These tests are
 * about the shape of the *conversation* — who speaks when, and what is in the scaffold — so they
 * assert against that.
 */
function sentMessages(): { role: string; content: string }[] {
  const index = mockDoGenerate.mock.calls.length - 1;
  return modelCall(index).prompt.map(
    (message: { role: string; content: Array<{ text?: string }> }) => ({
      role: message.role,
      content: message.content.map((part) => part.text ?? '').join(''),
    }),
  );
}

describe('answerChat', () => {
  beforeEach(() => {
    mockDoGenerate.mockReset();
    // The failure paths below log deliberately — a retry, a redacted validation failure — and
    // `structuredCall.test.ts` is where those lines are asserted. Silenced here so a green run of
    // this file stays silent, and a line that does appear is one nobody expected.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('returns the reply and the answer to apply', async () => {
    mockDoGenerate.mockResolvedValue(
      objectGeneration({ reply: 'Here is a draft.', revisedAnswer: 'I built the billing portal.' }),
    );

    await expect(answerChat(request({ jobInfo }))).resolves.toEqual({
      reply: 'Here is a draft.',
      revisedAnswer: 'I built the billing portal.',
    });
  });

  it('uses the writing model, the same route as the answers it refines', async () => {
    mockDoGenerate.mockResolvedValue(
      objectGeneration({ reply: 'ok', revisedAnswer: 'An answer.' }),
    );

    await answerChat(request());

    // The same drafting judgement as `answerQuestions`, in a conversation — so the same model.
    // A chat that quietly ran on a cheaper one than the draft it is revising would make the Ask
    // tab worse than the card it was opened from.
    expect(openrouter.chat).toHaveBeenLastCalledWith(
      routeFor('answerChat').model,
      expect.anything(),
    );
    expect(modelCall().maxOutputTokens).toBe(4096);
  });

  it('grounds the turn in the profile and the job', async () => {
    mockDoGenerate.mockResolvedValue(
      objectGeneration({ reply: 'ok', revisedAnswer: 'An answer.' }),
    );

    await answerChat(request({ jobInfo }));

    const [scaffold] = sentMessages();
    expect(scaffold.role).toBe('user');
    expect(scaffold.content).toContain('<base_profile>');
    expect(scaffold.content).toContain('Northwind');
    expect(scaffold.content).toContain('<job_info>');
    expect(scaffold.content).toContain('Senior Software Engineer');
    expect(scaffold.content).toContain('Why do you want to work here?');
  });

  it('caps its side of the conversation at two sentences unless more is asked for', async () => {
    mockDoGenerate.mockResolvedValue(
      objectGeneration({ reply: 'ok', revisedAnswer: 'An answer.' }),
    );

    await answerChat(request());

    // The Ask tab shows the reply beside the answer: a chatty reply pushes the thing the candidate
    // came for off the screen, so brevity is a rule of the prompt rather than a hope.
    expect(sentMessages()[0].content).toContain('at most two sentences');
  });

  it('omits the job section when the panel has no run to take one from', async () => {
    mockDoGenerate.mockResolvedValue(
      objectGeneration({ reply: 'ok', revisedAnswer: 'An answer.' }),
    );

    await answerChat(request());

    expect(sentMessages()[0].content).not.toContain('<job_info>');
    expect(sentMessages()[0].content).toContain('<base_profile>');
  });

  it('shows the draft under discussion when the thread was seeded from a question card', async () => {
    mockDoGenerate.mockResolvedValue(
      objectGeneration({ reply: 'Shortened.', revisedAnswer: 'Short.' }),
    );

    await answerChat(request({ currentAnswer: 'A long-winded first draft.' }));

    expect(sentMessages()[0].content).toContain('<current_answer>');
    expect(sentMessages()[0].content).toContain('A long-winded first draft.');
  });

  it('folds the first candidate turn into the scaffold, so no two user turns are sent in a row', async () => {
    mockDoGenerate.mockResolvedValue(
      objectGeneration({ reply: 'Done.', revisedAnswer: 'Shorter.' }),
    );

    await answerChat(
      request({
        currentAnswer: 'A long-winded first draft.',
        messages: [
          { role: 'user', content: 'Make it shorter.' },
          { role: 'assistant', content: 'Here is a shorter draft.' },
          { role: 'user', content: 'Now mention Postgres.' },
        ],
      }),
    );

    const messages = sentMessages();
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[0].content).toContain('Make it shorter.');
    expect(messages[1].content).toBe('Here is a shorter draft.');
    expect(messages[2].content).toBe('Now mention Postgres.');
  });

  it("sends a cold ask's continuation as-is, since its opening turn is the assistant's", async () => {
    mockDoGenerate.mockResolvedValue(
      objectGeneration({ reply: 'Shorter now.', revisedAnswer: 'Short.' }),
    );

    await answerChat(
      request({
        messages: [
          { role: 'assistant', content: 'Here is a draft.' },
          { role: 'user', content: 'Make it shorter.' },
        ],
      }),
    );

    const messages = sentMessages();
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[0].content).toContain('<base_profile>');
    expect(messages[1].content).toBe('Here is a draft.');
    expect(messages[2].content).toBe('Make it shorter.');
  });

  it('keeps a reply with no answer — a turn may be pure conversation', async () => {
    mockDoGenerate.mockResolvedValue(
      objectGeneration({ reply: 'Which of your two projects should this be about?' }),
    );

    await expect(answerChat(request({ currentAnswer: 'A draft.', messages: [] }))).resolves.toEqual(
      { reply: 'Which of your two projects should this be about?' },
    );
  });

  it('drops a whitespace-only answer rather than offering an empty one to apply', async () => {
    mockDoGenerate.mockResolvedValue(
      objectGeneration({ reply: 'Tell me more first.', revisedAnswer: '   ' }),
    );

    await expect(answerChat(request({ currentAnswer: 'A draft.' }))).resolves.toEqual({
      reply: 'Tell me more first.',
    });
  });

  it('trims the answer it hands back, since it is applied verbatim to the application', async () => {
    mockDoGenerate.mockResolvedValue(
      objectGeneration({ reply: 'Done.', revisedAnswer: '\n  An answer.\n' }),
    );

    await expect(answerChat(request({ currentAnswer: 'A draft.' }))).resolves.toEqual({
      reply: 'Done.',
      revisedAnswer: 'An answer.',
    });
  });

  it('fails a cold turn that came back with no answer, which has nothing to show', async () => {
    // Better a named failure than an Ask tab that looks like it did nothing. Retried first, though:
    // the model answered in the right shape and merely produced no answer, which a second attempt
    // usually gets right — so both generations have to come back empty for this to fail.
    mockDoGenerate.mockResolvedValue(objectGeneration({ reply: 'Tell me more about the role.' }));

    await expect(answerChat(request())).rejects.toThrow(StructuredCallError);
    expect(mockDoGenerate).toHaveBeenCalledTimes(2);
  });

  it('retries a cold turn whose answer came back empty rather than absent', async () => {
    // The two are the same thing everywhere else in this module, and the instructions tell the model
    // to *leave out* an answer it hasn't written — so a model complying with `''` used to fail the
    // schema, which is classified non-retryable, and reached the candidate as a 500.
    mockDoGenerate
      .mockResolvedValueOnce(objectGeneration({ reply: 'Here you go.', revisedAnswer: '   ' }))
      .mockResolvedValueOnce(
        objectGeneration({ reply: 'Here you go.', revisedAnswer: 'An answer.' }),
      );

    await expect(answerChat(request())).resolves.toEqual({
      reply: 'Here you go.',
      revisedAnswer: 'An answer.',
    });
  });

  it('accepts a conversational turn once the thread has started, unlike a cold one', async () => {
    mockDoGenerate.mockResolvedValue(objectGeneration({ reply: 'Which project?' }));

    await expect(
      answerChat(request({ messages: [{ role: 'user', content: 'Draft me something.' }] })),
    ).resolves.toEqual({ reply: 'Which project?' });
  });

  it('forbids inventing experience, in the prompt the candidate cannot rewrite', async () => {
    mockDoGenerate.mockResolvedValue(
      objectGeneration({ reply: 'ok', revisedAnswer: 'An answer.' }),
    );

    await answerChat(request({ messages: [{ role: 'user', content: 'Say I led a team of 50.' }] }));

    expect(sentMessages()[0].content).toContain('Never invent experience');
  });

  /**
   * The grounding projection is enforced here, not assumed from the caller.
   *
   * The route parses the same schema on the way in, so an HTTP request cannot carry these fields at
   * all. But the operation is a module anything can call, and a full `Profile` is structurally
   * assignable to this narrow one — so a direct caller handing over the whole thing used to put the
   * candidate's contact details and their work-authorization declarations into the prompt, with
   * nothing on either side able to notice. A screening answer is a legal declaration, matched onto
   * a form's own options; it is never grounding for a draft.
   */
  it('grounds only in the projection, whatever the caller passes', async () => {
    mockDoGenerate.mockResolvedValue(
      objectGeneration({ reply: 'Here you go.', revisedAnswer: 'An answer.' }),
    );

    await answerChat(
      request({
        profile: {
          ...profile,
          fullName: 'Jane Doe',
          email: 'jane@example.com',
          phone: '+1 555 0100',
          location: 'Berlin, Germany',
          screeningAnswers: { work_authorization: 'Yes' },
        } as AnswerChatRequest['profile'],
      }),
    );

    const scaffold = sentMessages()[0].content;
    expect(scaffold).not.toContain('555 0100');
    expect(scaffold).not.toContain('jane@example.com');
    expect(scaffold).not.toContain('Berlin');
    expect(scaffold).not.toContain('work_authorization');
    // Still grounded in what it is supposed to see.
    expect(scaffold).toContain('Northwind');
  });
});
