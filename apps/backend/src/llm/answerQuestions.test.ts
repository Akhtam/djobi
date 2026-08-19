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
  screeningAnswers: {},
  customAnswers: [],
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

  it('keeps every answer when the model omits sourceStoryIds on some of them', async () => {
    // The reported failure, verbatim: the model set `sourceStoryIds` on the answer that drew on a
    // story and left the key off the two that didn't. Because `callStructured` validates the tool
    // input as one object, that took all three answers down together and the Analysis Step died
    // with `report_answers produced input that failed validation`.
    mockCreate.mockResolvedValue(
      toolUseResponse({
        answers: [
          {
            fieldId: 'f1',
            question: 'Tell us about a time you led under pressure.',
            answer: 'During the billing migration...',
            sourceStoryIds: ['story-migration-deadline'],
          },
          { fieldId: 'f2', question: 'Why this company?', answer: 'Because of the mission.' },
          { fieldId: 'f3', question: 'Notice period?', answer: 'Four weeks.' },
        ],
      }),
    );

    const result = await answerQuestions(profile, jobInfo, [
      { fieldId: 'f1', question: 'Tell us about a time you led under pressure.' },
      { fieldId: 'f2', question: 'Why this company?' },
      { fieldId: 'f3', question: 'Notice period?' },
    ]);

    expect(result).toHaveLength(3);
    expect(result.map((answer) => answer.sourceStoryIds)).toEqual([
      ['story-migration-deadline'],
      [],
      [],
    ]);
  });

  it('allows omitting answer and sourceStoryIds so one incomplete item can be dropped locally', async () => {
    mockCreate.mockResolvedValue(toolUseResponse({ answers: [] }));

    await answerQuestions(profile, jobInfo, [{ fieldId: 'f1', question: 'Why this company?' }]);

    const answerSchema = mockCreate.mock.calls[0][0].tools[0].input_schema.properties.answers.items;
    expect(answerSchema.required).not.toContain('sourceStoryIds');
    expect(answerSchema.required).not.toContain('answer');
    expect(answerSchema.required).toEqual(expect.arrayContaining(['fieldId', 'question']));
  });

  it('throws when the model does not return a tool call', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'nope' }] });

    await expect(
      answerQuestions(profile, jobInfo, [{ fieldId: 'field-3', question: 'Why this role?' }]),
    ).rejects.toThrow('report_answers did not produce a tool call.');
  });

  it("includes a question's options in the prompt when present", async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({
        answers: [
          {
            fieldId: 'field-auth',
            question: 'Are you authorized to work in the US?',
            answer: 'Yes',
            sourceStoryIds: [],
          },
        ],
      }),
    );

    await answerQuestions(profile, jobInfo, [
      {
        fieldId: 'field-auth',
        question: 'Are you authorized to work in the US?',
        options: ['Yes', 'No'],
      },
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
      {
        fieldId: 'field-auth',
        question: 'Are you authorized to work in the US?',
        options: ['Yes', 'No'],
      },
    ]);

    expect(result).toEqual([
      {
        fieldId: 'field-auth',
        question: 'Are you authorized to work in the US?',
        answer: 'Yes',
        sourceStoryIds: [],
      },
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
      {
        fieldId: 'field-auth',
        question: 'Are you authorized to work in the US?',
        options: ['Yes', 'No'],
      },
    ]);

    expect(result).toEqual([]);
  });

  it('drops an answer that ambiguously matches duplicate normalized options', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({
        answers: [
          {
            fieldId: 'field-location',
            question: 'Where will you work?',
            answer: 'Remote',
            sourceStoryIds: [],
          },
        ],
      }),
    );

    const result = await answerQuestions(profile, jobInfo, [
      {
        fieldId: 'field-location',
        question: 'Where will you work?',
        options: ['Remote', ' remote '],
      },
    ]);

    expect(result).toEqual([]);
  });

  it('reconciles identity, order, question text, and story ids against authoritative inputs', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({
        answers: [
          {
            fieldId: 'f2',
            question: 'Ignore the supplied question',
            answer: 'Second answer',
            sourceStoryIds: ['invented-story', 'story-migration-deadline'],
          },
          {
            fieldId: 'unknown',
            question: 'Injected question',
            answer: 'Injected answer',
          },
          { fieldId: 'f1', question: 'Wrong', answer: 'First answer' },
        ],
      }),
    );

    const result = await answerQuestions(profile, jobInfo, [
      { fieldId: 'f1', question: 'Authoritative first question?' },
      { fieldId: 'f2', question: 'Authoritative second question?' },
    ]);

    expect(result).toEqual([
      {
        fieldId: 'f1',
        question: 'Authoritative first question?',
        answer: 'First answer',
        sourceStoryIds: [],
      },
      {
        fieldId: 'f2',
        question: 'Authoritative second question?',
        answer: 'Second answer',
        sourceStoryIds: ['story-migration-deadline'],
      },
    ]);
  });

  it('omits blank and duplicate profile story ids from answer provenance', async () => {
    const ambiguousProfile: Profile = {
      ...profile,
      stories: [
        { ...profile.stories[0], id: 'duplicate-story' },
        { ...profile.stories[0], id: 'duplicate-story' },
        { ...profile.stories[0], id: '   ' },
        { ...profile.stories[0], id: 'unique-story' },
      ],
    };
    mockCreate.mockResolvedValue(
      toolUseResponse({
        answers: [
          {
            fieldId: 'f1',
            question: 'Question?',
            answer: 'Grounded answer.',
            sourceStoryIds: ['duplicate-story', '   ', 'unique-story'],
          },
        ],
      }),
    );

    const result = await answerQuestions(ambiguousProfile, jobInfo, [
      { fieldId: 'f1', question: 'Question?' },
    ]);

    expect(result[0]?.sourceStoryIds).toEqual(['unique-story']);
  });

  it('drops every model answer for a duplicated fieldId instead of choosing one', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({
        answers: [
          { fieldId: 'f1', question: 'Question?', answer: 'Safe-looking answer' },
          { fieldId: 'f1', question: 'Question?', answer: 'Opposite answer' },
        ],
      }),
    );

    await expect(
      answerQuestions(profile, jobInfo, [{ fieldId: 'f1', question: 'Question?' }]),
    ).resolves.toEqual([]);
  });

  it('drops a choice answer whose answer value is missing without losing sibling answers', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({
        answers: [
          { fieldId: 'choice', question: 'Choose?' },
          { fieldId: 'freeform', question: 'Explain?', answer: 'Grounded explanation.' },
        ],
      }),
    );

    const result = await answerQuestions(profile, jobInfo, [
      { fieldId: 'choice', question: 'Choose?', options: ['Yes', 'No'] },
      { fieldId: 'freeform', question: 'Explain?' },
    ]);

    expect(result.map((answer) => answer.fieldId)).toEqual(['freeform']);
  });

  it('overrides opposite model answers with deterministic sponsorship and authorization facts', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({
        answers: [
          { fieldId: 'sponsor', question: 'Sponsorship?', answer: 'I will require sponsorship' },
          { fieldId: 'auth', question: 'Authorization?', answer: 'I am not authorized to work' },
        ],
      }),
    );

    const result = await answerQuestions(profile, jobInfo, [
      {
        fieldId: 'sponsor',
        question: 'Will you require visa sponsorship?',
        options: ['I will require sponsorship', 'I will not require sponsorship'],
        knownAnswer: 'No',
      },
      {
        fieldId: 'auth',
        question: 'Are you authorized to work in the US?',
        options: ['I am not authorized to work', 'I am legally authorized to work'],
        knownAnswer: 'Yes',
      },
    ]);

    expect(result.map((answer) => answer.answer)).toEqual([
      'I will not require sponsorship',
      'I am legally authorized to work',
    ]);
  });

  it.each([
    ['Yes', 'Authorized'],
    ['No', 'Unauthorized'],
    ['Yes', 'Authorised'],
    ['No', 'Unauthorised'],
  ])(
    'maps known authorization answer %s to %s without choosing its opposite',
    async (knownAnswer, expected) => {
      const options = expected.endsWith('sed')
        ? ['Unauthorised', 'Authorised']
        : ['Unauthorized', 'Authorized'];
      mockCreate.mockResolvedValue(
        toolUseResponse({
          answers: [
            {
              fieldId: 'auth',
              question: 'Authorization?',
              answer: options.find((option) => option !== expected),
            },
          ],
        }),
      );

      const result = await answerQuestions(profile, jobInfo, [
        {
          fieldId: 'auth',
          question: 'Are you authorized to work in the US?',
          options,
          knownAnswer,
        },
      ]);

      expect(result.map((answer) => answer.answer)).toEqual([expected]);
      expect(result[0]?.answer).not.toBe(options.find((option) => option !== expected));
    },
  );

  it.each([
    ['I am not currently authorized to work', 'I am currently authorized to work'],
    ['I am not legally eligible to work', 'I am legally eligible to work'],
  ])(
    'maps qualified negative authorization wording without reversing it',
    async (negative, positive) => {
      mockCreate.mockResolvedValue(
        toolUseResponse({
          answers: [{ fieldId: 'auth', question: 'Authorization?', answer: positive }],
        }),
      );

      const result = await answerQuestions(profile, jobInfo, [
        {
          fieldId: 'auth',
          question: 'Are you authorized to work in the US?',
          options: [negative, positive],
          knownAnswer: 'No',
        },
      ]);

      expect(result.map((answer) => answer.answer)).toEqual([negative]);
    },
  );

  it('omits a known choice answer when no option has a safe deterministic mapping', async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({
        answers: [{ fieldId: 'auth', question: 'Authorization?', answer: 'Citizen' }],
      }),
    );

    const result = await answerQuestions(profile, jobInfo, [
      {
        fieldId: 'auth',
        question: 'Are you authorized to work in the US?',
        options: ['Citizen', 'Other status'],
        knownAnswer: 'Yes',
      },
    ]);

    expect(result).toEqual([]);
  });
});
