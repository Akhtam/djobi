import type { AnswerChatRequest, JobInfo } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock('./client.js', () => ({
  anthropic: { messages: { create: mockCreate } },
  MODELS: { extraction: 'claude-haiku-4-5', writing: 'claude-sonnet-5' },
}));

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

function toolUseResponse(input: unknown) {
  return { content: [{ type: 'tool_use', id: 'toolu_1', name: 'report_chat_turn', input }] };
}

/** The request body as sent, minus whatever a test is making a point about. */
function request(overrides: Partial<AnswerChatRequest> = {}): AnswerChatRequest {
  return { profile, question: 'Why do you want to work here?', messages: [], ...overrides };
}

/** The `messages` array handed to the Messages API on the most recent call. */
function sentMessages(): { role: string; content: string }[] {
  return mockCreate.mock.calls.at(-1)![0].messages;
}

describe('answerChat', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('returns the reply and the answer to apply', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({ reply: 'Here is a draft.', revisedAnswer: 'I built the billing portal.' }),
    );

    await expect(answerChat(request({ jobInfo }))).resolves.toEqual({
      reply: 'Here is a draft.',
      revisedAnswer: 'I built the billing portal.',
    });
  });

  it('uses the writing model, the same tier as the answers it refines', async () => {
    mockCreate.mockResolvedValue(toolUseResponse({ reply: 'ok', revisedAnswer: 'An answer.' }));

    await answerChat(request());

    expect(mockCreate.mock.calls[0][0].model).toBe('claude-sonnet-5');
  });

  it('grounds the turn in the profile and the job', async () => {
    mockCreate.mockResolvedValue(toolUseResponse({ reply: 'ok', revisedAnswer: 'An answer.' }));

    await answerChat(request({ jobInfo }));

    const [scaffold] = sentMessages();
    expect(scaffold.role).toBe('user');
    expect(scaffold.content).toContain('<base_profile>');
    expect(scaffold.content).toContain('Northwind');
    expect(scaffold.content).toContain('<job_info>');
    expect(scaffold.content).toContain('Senior Software Engineer');
    expect(scaffold.content).toContain('Why do you want to work here?');
  });

  it('omits the job section when the panel has no run to take one from', async () => {
    mockCreate.mockResolvedValue(toolUseResponse({ reply: 'ok', revisedAnswer: 'An answer.' }));

    await answerChat(request());

    expect(sentMessages()[0].content).not.toContain('<job_info>');
    expect(sentMessages()[0].content).toContain('<base_profile>');
  });

  it('shows the draft under discussion when the thread was seeded from a question card', async () => {
    mockCreate.mockResolvedValue(toolUseResponse({ reply: 'Shortened.', revisedAnswer: 'Short.' }));

    await answerChat(request({ currentAnswer: 'A long-winded first draft.' }));

    expect(sentMessages()[0].content).toContain('<current_answer>');
    expect(sentMessages()[0].content).toContain('A long-winded first draft.');
  });

  it('folds the first candidate turn into the scaffold, so no two user turns are sent in a row', async () => {
    mockCreate.mockResolvedValue(toolUseResponse({ reply: 'Done.', revisedAnswer: 'Shorter.' }));

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
    mockCreate.mockResolvedValue(
      toolUseResponse({ reply: 'Shorter now.', revisedAnswer: 'Short.' }),
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
    mockCreate.mockResolvedValue(
      toolUseResponse({ reply: 'Which of your two projects should this be about?' }),
    );

    await expect(answerChat(request({ currentAnswer: 'A draft.', messages: [] }))).resolves.toEqual(
      { reply: 'Which of your two projects should this be about?' },
    );
  });

  it('drops a whitespace-only answer rather than offering an empty one to apply', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({ reply: 'Tell me more first.', revisedAnswer: '   ' }),
    );

    await expect(answerChat(request({ currentAnswer: 'A draft.' }))).resolves.toEqual({
      reply: 'Tell me more first.',
    });
  });

  it('trims the answer it hands back, since it is applied verbatim to the application', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({ reply: 'Done.', revisedAnswer: '\n  An answer.\n' }),
    );

    await expect(answerChat(request({ currentAnswer: 'A draft.' }))).resolves.toEqual({
      reply: 'Done.',
      revisedAnswer: 'An answer.',
    });
  });

  it('fails a cold turn that came back with no answer, which has nothing to show', async () => {
    // Not a retryable no-tool-call: the model answered, it just answered with a turn a fresh ask
    // cannot render. Better a named failure than an Ask tab that looks like it did nothing.
    mockCreate.mockResolvedValue(toolUseResponse({ reply: 'Tell me more about the role.' }));

    await expect(answerChat(request())).rejects.toThrow(StructuredCallError);
  });

  it('accepts a conversational turn once the thread has started, unlike a cold one', async () => {
    mockCreate.mockResolvedValue(toolUseResponse({ reply: 'Which project?' }));

    await expect(
      answerChat(request({ messages: [{ role: 'user', content: 'Draft me something.' }] })),
    ).resolves.toEqual({ reply: 'Which project?' });
  });

  it('forbids inventing experience, in the prompt the candidate cannot rewrite', async () => {
    mockCreate.mockResolvedValue(toolUseResponse({ reply: 'ok', revisedAnswer: 'An answer.' }));

    await answerChat(request({ messages: [{ role: 'user', content: 'Say I led a team of 50.' }] }));

    expect(sentMessages()[0].content).toContain('Never invent experience');
  });
});
