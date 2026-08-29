import type { JobInfo } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAnswerChat } = vi.hoisted(() => ({ mockAnswerChat: vi.fn() }));

vi.mock('../llm/answerChat.js', () => ({ answerChat: mockAnswerChat }));

const { app } = await import('../app.js');
const { StructuredCallError } = await import('../llm/structuredCall.js');

const profile = {
  workExperience: [],
  education: [],
  skills: ['TypeScript'],
  stories: [],
  customAnswers: [],
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

function post(body: unknown) {
  return app.request('/answer-chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /answer-chat', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockAnswerChat.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('answers a cold ask with no job and no thread', async () => {
    mockAnswerChat.mockResolvedValue({ reply: 'Here you go.', revisedAnswer: 'An answer.' });
    const body = { profile, question: 'Why do you want to work here?', messages: [] };

    const res = await post(body);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      reply: 'Here you go.',
      revisedAnswer: 'An answer.',
    });
    expect(mockAnswerChat).toHaveBeenCalledWith(body, expect.any(AbortSignal));
  });

  it('carries the seeded draft and the thread through to the model call', async () => {
    // The same route serves both flows, so what makes this a refinement is only what it sends —
    // a draft the route drops would turn every refinement into a cold ask without saying so.
    mockAnswerChat.mockResolvedValue({ reply: 'Shortened.', revisedAnswer: 'Short.' });
    const body = {
      profile,
      question: 'Why do you want to work here?',
      jobInfo,
      currentAnswer: 'A long-winded first draft.',
      messages: [{ role: 'user', content: 'Make it shorter.' }],
    };

    const res = await post(body);

    expect(res.status).toBe(200);
    expect(mockAnswerChat).toHaveBeenCalledWith(body, expect.any(AbortSignal));
  });

  it('returns a reply with no revised answer as-is', async () => {
    mockAnswerChat.mockResolvedValue({ reply: 'Which project should this be about?' });

    const res = await post({
      profile,
      question: 'Tell us about a challenge.',
      messages: [{ role: 'user', content: 'Draft me something.' }],
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ reply: 'Which project should this be about?' });
  });

  it('rejects a malformed thread as the bad request it is, not a provider failure', async () => {
    const res = await post({
      profile,
      question: 'Why us?',
      messages: [
        { role: 'user', content: 'Shorter.' },
        { role: 'user', content: 'And mention Postgres.' },
      ],
    });

    expect(res.status).toBe(400);
    expect(mockAnswerChat).not.toHaveBeenCalled();
  });

  it('returns 400 and does not call the model when the question is missing', async () => {
    const res = await post({ profile, messages: [] });

    expect(res.status).toBe(400);
    expect(mockAnswerChat).not.toHaveBeenCalled();
  });

  it('returns a JSON error body but does not expose the internal cause to the client', async () => {
    mockAnswerChat.mockRejectedValueOnce(
      new StructuredCallError(
        'invalid-input',
        'report_chat_turn',
        'report_chat_turn produced output that failed validation: revisedAnswer required',
        'req-1',
      ),
    );

    const res = await post({ profile, question: 'Why us?', messages: [] });

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    await expect(res.json()).resolves.toEqual({
      error: 'Internal server error',
    });
  });
});
