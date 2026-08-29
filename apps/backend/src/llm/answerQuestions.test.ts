import { QuestionAnswerSchema, type JobInfo, type Profile } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generation,
  mockDoGenerate,
  modelCall,
  objectGeneration,
  openrouter,
  promptText as turnText,
} from './fakeModel.js';

vi.mock('./client.js', () => import('./fakeModel.js'));

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

/**
 * The whole prompt of one call, as text.
 *
 * The user turn carries the stable instructions-and-Profile prefix followed by the job and the one
 * question, so a test asking "was this in the prompt" reads the whole turn.
 */
function promptText(callIndex = 0): string {
  return turnText(0, callIndex);
}

/**
 * Answers each call with the entries whose `fieldId` that call actually asked about.
 *
 * One call per question means a mock resolving the same full list every time would hand every
 * fieldId back once per question, and `reconcileAnswers` drops a duplicated fieldId rather than
 * choosing between them — so a batch-shaped mock reads as "the model answered nothing".
 */
function respondPerQuestion(answers: { fieldId: string }[]) {
  mockDoGenerate.mockImplementation((request: { prompt: { content: { text?: string }[] }[] }) => {
    const text = request.prompt[0].content.map((part) => part.text ?? '').join('');
    return Promise.resolve(
      objectGeneration({
        answers: answers.filter((answer) => text.includes(`"${answer.fieldId}"`)),
      }),
    );
  });
}

describe('answerQuestions', () => {
  beforeEach(() => {
    mockDoGenerate.mockReset();
  });

  it('returns an empty array without calling the model when there are no questions', async () => {
    const result = await answerQuestions(profile, jobInfo, []);

    expect(result).toEqual([]);
    expect(mockDoGenerate).not.toHaveBeenCalled();
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
    mockDoGenerate.mockResolvedValue(objectGeneration({ answers }));

    const result = await answerQuestions(profile, jobInfo, [
      { fieldId: 'field-3', question: 'Tell us about a time you led under pressure.' },
    ]);

    expect(result).toEqual(answers);
    for (const answer of result) {
      expect(QuestionAnswerSchema.safeParse(answer).success).toBe(true);
    }
    expect(mockDoGenerate).toHaveBeenCalledTimes(1);
    expect(openrouter.chat).toHaveBeenLastCalledWith(
      'anthropic/claude-sonnet-5',
      expect.anything(),
    );

    expect(modelCall().responseFormat).toMatchObject({ type: 'json', name: 'report_answers' });
    expect(promptText()).toContain('story-migration-deadline');
    expect(promptText()).toContain('led under pressure');
  });

  it('sends one call per question, each carrying only its own question', async () => {
    // The change that made this operation fast: the answers are written concurrently rather than
    // one after another inside a single response, so its latency is the longest answer instead of
    // the sum of all of them.
    respondPerQuestion([
      { fieldId: 'f1', question: 'First?', answer: 'First answer.', sourceStoryIds: [] },
      { fieldId: 'f2', question: 'Second?', answer: 'Second answer.', sourceStoryIds: [] },
      { fieldId: 'f3', question: 'Third?', answer: 'Third answer.', sourceStoryIds: [] },
    ]);

    const result = await answerQuestions(profile, jobInfo, [
      { fieldId: 'f1', question: 'First?' },
      { fieldId: 'f2', question: 'Second?' },
      { fieldId: 'f3', question: 'Third?' },
    ]);

    expect(result.map((answer) => answer.fieldId)).toEqual(['f1', 'f2', 'f3']);
    expect(mockDoGenerate).toHaveBeenCalledTimes(3);
    expect(promptText(0)).toContain('First?');
    expect(promptText(0)).not.toContain('Second?');
    expect(promptText(1)).toContain('Second?');
  });

  it('leads every call with the identical instructions-and-profile half, so the repeats are cache reads', async () => {
    // Fanning out sends the Profile once per question. There is no marker to send any more — these
    // models cache implicitly, on a byte-identical *leading* prefix — so the ordering is the whole
    // of what keeps that from being billed at full rate N times over.
    respondPerQuestion([
      { fieldId: 'f1', question: 'First?', answer: 'First answer.', sourceStoryIds: [] },
      { fieldId: 'f2', question: 'Second?', answer: 'Second answer.', sourceStoryIds: [] },
    ]);

    await answerQuestions(profile, jobInfo, [
      { fieldId: 'f1', question: 'First?' },
      { fieldId: 'f2', question: 'Second?' },
    ]);

    const [first, second] = [promptText(0), promptText(1)];
    const sharedPrefix = first.slice(0, first.indexOf('<job_info>'));
    expect(sharedPrefix).toContain('<base_profile>');
    // Byte-identical across the calls, or the cache never hits.
    expect(second.startsWith(sharedPrefix)).toBe(true);
    // ...and the half that varies comes after it, never inside it.
    expect(sharedPrefix).not.toContain('<job_info>');
    expect(first.slice(sharedPrefix.length)).toContain('<job_info>');
    expect(JSON.stringify(modelCall().prompt)).not.toContain('cache_control');
  });

  it('never calls the model for a question the profile already answers', async () => {
    // `matchKnownAnswer` resolves these locally, and always did — the draft the model returned
    // beside it was read for nothing. Sending them cost output tokens on the critical path for a
    // result that was discarded.
    const result = await answerQuestions(profile, jobInfo, [
      {
        fieldId: 'sponsor',
        question: 'Will you require visa sponsorship?',
        options: ['I will require sponsorship', 'I will not require sponsorship'],
        knownAnswer: 'No',
      },
    ]);

    expect(mockDoGenerate).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        fieldId: 'sponsor',
        question: 'Will you require visa sponsorship?',
        answer: 'I will not require sponsorship',
        sourceStoryIds: [],
      },
    ]);
  });

  it('keeps the other answers when one question’s call fails', async () => {
    let call = 0;
    mockDoGenerate.mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.reject(new Error('provider exploded'));
      return Promise.resolve(
        objectGeneration({
          answers: [{ fieldId: 'f2', question: 'Second?', answer: 'Second answer.' }],
        }),
      );
    });

    const result = await answerQuestions(profile, jobInfo, [
      { fieldId: 'f1', question: 'First?' },
      { fieldId: 'f2', question: 'Second?' },
    ]);

    expect(result.map((answer) => answer.fieldId)).toEqual(['f2']);
  });

  it('throws the original failure when every question fails, rather than reporting no answers', async () => {
    mockDoGenerate.mockRejectedValue(new Error('provider exploded'));

    await expect(
      answerQuestions(profile, jobInfo, [
        { fieldId: 'f1', question: 'First?' },
        { fieldId: 'f2', question: 'Second?' },
      ]),
    ).rejects.toThrow('provider exploded');
  });

  it('keeps every answer when the model omits sourceStoryIds on some of them', async () => {
    // The reported failure, verbatim: the model set `sourceStoryIds` on the answer that drew on a
    // story and left the key off the two that didn't. Because `callStructured` validates the tool
    // input as one object, that took all three answers down together and the Analysis Step died
    // with `report_answers produced output that failed validation`.
    respondPerQuestion([
      {
        fieldId: 'f1',
        question: 'Tell us about a time you led under pressure.',
        answer: 'During the billing migration...',
        sourceStoryIds: ['story-migration-deadline'],
      },
      { fieldId: 'f2', question: 'Why this company?', answer: 'Because of the mission.' },
      { fieldId: 'f3', question: 'Notice period?', answer: 'Four weeks.' },
    ]);

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

  it('requires the answer itself, and lets sourceStoryIds be omitted', async () => {
    // These two are not the same case, and one call per question is why. `sourceStoryIds` absent
    // states a fact — the answer drew on no story — and the schema default says so locally.
    // `answer` absent is the call having produced nothing at all: there are no sibling answers left
    // for it to be dropped beside. In live provider testing, optional meant omitted, and the run
    // reconciled to zero answers while every call reported success.
    mockDoGenerate.mockResolvedValue(objectGeneration({ answers: [] }));

    await answerQuestions(profile, jobInfo, [{ fieldId: 'f1', question: 'Why this company?' }]);

    const answerSchema = modelCall().responseFormat.schema.properties.answers.items;
    expect(answerSchema.required).not.toContain('sourceStoryIds');
    expect(answerSchema.required).toEqual(expect.arrayContaining(['fieldId', 'answer']));
    // Not asked for at all: reconciliation takes the question text from the authoritative input, so
    // an echoed copy was output tokens spent on something already known — ~16% of them per call.
    expect(answerSchema.properties).not.toHaveProperty('question');
  });

  it('fails loudly when the model returns an item with no answer in it', async () => {
    // The failure this replaced was silent: the item validated, `reconcileAnswers` dropped it for
    // having no answer, and the operation reported a form it had answered none of as a success.
    mockDoGenerate.mockResolvedValue(
      objectGeneration({ answers: [{ fieldId: 'f1', sourceStoryIds: [] }] }),
    );

    await expect(
      answerQuestions(profile, jobInfo, [{ fieldId: 'f1', question: 'Why this company?' }]),
    ).rejects.toMatchObject({ kind: 'invalid-input', toolName: 'report_answers' });
  });

  it('throws when the model answers with something that is not the object', async () => {
    mockDoGenerate.mockResolvedValue(generation('nope'));

    await expect(
      answerQuestions(profile, jobInfo, [{ fieldId: 'field-3', question: 'Why this role?' }]),
    ).rejects.toThrow('report_answers did not produce a structured object.');
  });

  it("includes a question's options in the prompt when present", async () => {
    mockDoGenerate.mockResolvedValue(
      objectGeneration({
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

    expect(promptText()).toContain('"options"');
    expect(promptText()).toContain('"Yes"');
    expect(promptText()).toContain('"No"');
  });

  it('corrects a returned answer to the matching option when it differs only in case/whitespace', async () => {
    mockDoGenerate.mockResolvedValue(
      objectGeneration({
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
    mockDoGenerate.mockResolvedValue(
      objectGeneration({
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
    mockDoGenerate.mockResolvedValue(
      objectGeneration({
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
    // Each call answers its own question and smuggles in noise beside it: a fieldId nobody asked
    // about, question text that isn't the one supplied, and a story id that isn't in the profile.
    mockDoGenerate.mockImplementation((request: { prompt: { content: { text?: string }[] }[] }) => {
      const text = request.prompt[0].content.map((part) => part.text ?? '').join('');
      return Promise.resolve(
        objectGeneration({
          answers: text.includes('"f1"')
            ? [
                { fieldId: 'unknown', question: 'Injected question', answer: 'Injected answer' },
                { fieldId: 'f1', question: 'Wrong', answer: 'First answer' },
              ]
            : [
                {
                  fieldId: 'f2',
                  question: 'Ignore the supplied question',
                  answer: 'Second answer',
                  sourceStoryIds: ['invented-story', 'story-migration-deadline'],
                },
              ],
        }),
      );
    });

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
    mockDoGenerate.mockResolvedValue(
      objectGeneration({
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
    mockDoGenerate.mockResolvedValue(
      objectGeneration({
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
    respondPerQuestion([
      { fieldId: 'choice', question: 'Choose?' },
      { fieldId: 'freeform', question: 'Explain?', answer: 'Grounded explanation.' },
    ]);

    const result = await answerQuestions(profile, jobInfo, [
      { fieldId: 'choice', question: 'Choose?', options: ['Yes', 'No'] },
      { fieldId: 'freeform', question: 'Explain?' },
    ]);

    expect(result.map((answer) => answer.fieldId)).toEqual(['freeform']);
  });

  it('overrides opposite model answers with deterministic sponsorship and authorization facts', async () => {
    mockDoGenerate.mockResolvedValue(
      objectGeneration({
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
      mockDoGenerate.mockResolvedValue(
        objectGeneration({
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
      mockDoGenerate.mockResolvedValue(
        objectGeneration({
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
    mockDoGenerate.mockResolvedValue(
      objectGeneration({
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
