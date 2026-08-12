import { QuestionAnswerSchema, type JobInfo, type Profile } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock('./client.js', () => ({
  anthropic: { messages: { create: mockCreate } },
  MODELS: { extraction: 'claude-haiku-4-5', writing: 'claude-sonnet-5' },
}));

const { answerQuestions } = await import('./answerQuestions.js');

const profile: Profile = {
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: null,
  location: 'Remote',
  links: { linkedin: null, portfolio: null, github: null },
  workExperience: [],
  education: [],
  skills: ['TypeScript'],
  stories: [
    {
      id: 'story-migration-deadline',
      title: 'Migrated the billing service under a hard deadline',
      tags: ['leadership', 'incident-response'],
      situation: 'Legacy billing service was due to be sunset by an external vendor.',
      task: 'Lead the migration to the new service without downtime.',
      action: 'Wrote a dual-write shim, backfilled data, cut over gradually.',
      result: 'Migrated with zero downtime, two weeks ahead of the vendor deadline.',
    },
  ],
};

const jobInfo: JobInfo = {
  company: 'Acme',
  team: 'Platform',
  roleTitle: 'Senior Software Engineer',
  seniority: 'Senior',
  location: 'Remote',
  requirements: ['5+ years of backend experience'],
  keywords: ['TypeScript', 'Postgres'],
};

function toolUseResponse(input: unknown) {
  return {
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'report_answers', input }],
  };
}

describe('answerQuestions', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('returns an empty array without calling the model when there are no questions', async () => {
    const result = await answerQuestions(profile, jobInfo, []);

    expect(result).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('calls the writing model and returns the drafted answers', async () => {
    const answers = [
      {
        fieldId: 'field-3',
        question: 'Tell us about a time you led under pressure.',
        answer: 'During the billing migration at Acme...',
        sourceStoryIds: ['story-migration-deadline'],
      },
    ];
    mockCreate.mockResolvedValue(toolUseResponse({ answers }));

    const result = await answerQuestions(profile, jobInfo, [
      { fieldId: 'field-3', question: 'Tell us about a time you led under pressure.' },
    ]);

    expect(result).toEqual(answers);
    for (const answer of result) {
      expect(QuestionAnswerSchema.safeParse(answer).success).toBe(true);
    }
    expect(mockCreate).toHaveBeenCalledTimes(1);

    const request = mockCreate.mock.calls[0][0];
    expect(request.model).toBe('claude-sonnet-5');
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'report_answers' });
    expect(request.messages[0].content).toContain('story-migration-deadline');
    expect(request.messages[0].content).toContain('led under pressure');
  });

  it('throws when the model does not return a tool call', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'nope' }] });

    await expect(
      answerQuestions(profile, jobInfo, [{ fieldId: 'field-3', question: 'Why this role?' }]),
    ).rejects.toThrow('report_answers did not produce a tool call.');
  });

  it('includes a question\'s options in the prompt when present', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({
        answers: [
          { fieldId: 'field-auth', question: 'Are you authorized to work in the US?', answer: 'Yes', sourceStoryIds: [] },
        ],
      }),
    );

    await answerQuestions(profile, jobInfo, [
      { fieldId: 'field-auth', question: 'Are you authorized to work in the US?', options: ['Yes', 'No'] },
    ]);

    const request = mockCreate.mock.calls[0][0];
    expect(request.messages[0].content).toContain('"options"');
    expect(request.messages[0].content).toContain('"Yes"');
    expect(request.messages[0].content).toContain('"No"');
  });

  it('corrects a returned answer to the matching option when it differs only in case/whitespace', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({
        answers: [
          {
            fieldId: 'field-auth',
            question: 'Are you authorized to work in the US?',
            answer: ' yes ',
            sourceStoryIds: [],
          },
        ],
      }),
    );

    const result = await answerQuestions(profile, jobInfo, [
      { fieldId: 'field-auth', question: 'Are you authorized to work in the US?', options: ['Yes', 'No'] },
    ]);

    expect(result).toEqual([
      { fieldId: 'field-auth', question: 'Are you authorized to work in the US?', answer: 'Yes', sourceStoryIds: [] },
    ]);
  });

  it('drops an answer that matches none of the given options', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({
        answers: [
          {
            fieldId: 'field-auth',
            question: 'Are you authorized to work in the US?',
            answer: 'Not sure',
            sourceStoryIds: [],
          },
        ],
      }),
    );

    const result = await answerQuestions(profile, jobInfo, [
      { fieldId: 'field-auth', question: 'Are you authorized to work in the US?', options: ['Yes', 'No'] },
    ]);

    expect(result).toEqual([]);
  });
});
