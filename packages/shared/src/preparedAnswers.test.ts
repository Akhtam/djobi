import { describe, expect, it } from 'vitest';
import { matchScreeningTopic } from './screeningAnswers.js';
import { matchPreparedAnswerToOption } from './labelMatching.js';
import { preparedAnswerFor, splitPreparedQuestions } from './preparedAnswers.js';

const profile = {
  screeningAnswers: {
    work_authorization: 'Yes',
    sponsorship_required: 'No',
    veteran_status: 'I am not a protected veteran',
  } as Record<string, string>,
  customAnswers: [{ question: 'How did you hear about us?', answer: 'LinkedIn' }],
};

describe('matchScreeningTopic', () => {
  it.each([
    ['Are you legally authorized to work in the United States?', 'work_authorization'],
    ['Do you have the right to work in the UK?', 'work_authorization'],
    ['Will you now or in the future require visa sponsorship?', 'sponsorship_required'],
    ['Are you willing to relocate to New York?', 'relocation'],
    ['What is your notice period?', 'notice_period'],
    ['Are you a protected veteran?', 'veteran_status'],
    ['Do you identify as having a disability?', 'disability_status'],
    ['How did you hear about this role?', 'referral_source'],
  ])('recognizes %j as %s', (question, topic) => {
    expect(matchScreeningTopic(question)).toBe(topic);
  });

  it('reads a question mentioning both authorization and sponsorship as a work-authorization question', () => {
    expect(matchScreeningTopic('Are you authorized to work in the US without sponsorship?')).toBe(
      'work_authorization',
    );
  });

  it('returns undefined for a question that is genuinely about this job', () => {
    expect(matchScreeningTopic('Why do you want to work at Acme?')).toBeUndefined();
    expect(matchScreeningTopic('Describe a hard technical problem you solved.')).toBeUndefined();
  });
});

describe('resolveAnswerOption', () => {
  it("maps a stored Yes onto an ATS's long-form spelling of it", () => {
    const options = [
      'Yes, I am legally authorized to work in the United States',
      'No, I am not legally authorized',
    ];

    expect(matchPreparedAnswerToOption(options, 'Yes')).toBe(options[0]);
    expect(matchPreparedAnswerToOption(options, 'No')).toBe(options[1]);
  });

  it("doesn't let No match None of the above — a prefix running into more letters is a different word", () => {
    expect(
      matchPreparedAnswerToOption(['None of the above', 'Something else'], 'No'),
    ).toBeUndefined();
  });

  it('prefers an exact match over a longer option that merely starts with the same word', () => {
    expect(matchPreparedAnswerToOption(['Yes', 'Yes, with conditions'], 'Yes')).toBe('Yes');
  });

  it('refuses an ambiguous match rather than guessing between two options', () => {
    const options = ['Yes, currently', 'Yes, from January'];

    expect(matchPreparedAnswerToOption(options, 'Yes')).toBeUndefined();
  });

  it('falls back to a unique substring match', () => {
    const options = ['I am not a protected veteran', 'I identify as a protected veteran'];

    expect(matchPreparedAnswerToOption(options, 'not a protected veteran')).toBe(options[0]);
  });
});

describe('preparedAnswerFor', () => {
  it('answers from a screening topic', () => {
    expect(preparedAnswerFor(profile, 'Will you require sponsorship?')).toBe('No');
  });

  it('answers from a custom entry when no topic matches, matching loosely on wording', () => {
    expect(preparedAnswerFor(profile, 'How did you hear about us?')).toBe('LinkedIn');
  });

  it('returns undefined for a topic the profile has left blank', () => {
    expect(preparedAnswerFor(profile, 'Are you willing to relocate?')).toBeUndefined();
  });

  it("returns undefined for a question that isn't prepared at all", () => {
    expect(preparedAnswerFor(profile, 'Why do you want to work here?')).toBeUndefined();
  });

  it('treats a profile with neither field as simply having no prepared answers', () => {
    // A profile stored before these fields existed. Having none is an ordinary state — it must mean
    // "ask the model everything", not abort the Analysis Step.
    const legacy = {} as never;

    expect(preparedAnswerFor(legacy, 'Will you require sponsorship?')).toBeUndefined();
    expect(preparedAnswerFor(legacy, 'How did you hear about us?')).toBeUndefined();
  });
});

describe('splitPreparedQuestions', () => {
  it('resolves a free-text question from the profile, keeping it away from the model entirely', () => {
    const { resolved, forModel } = splitPreparedQuestions(profile, [
      { fieldId: 'f1', question: 'Are you legally authorized to work in the US?' },
    ]);

    expect(resolved).toEqual([
      {
        fieldId: 'f1',
        question: 'Are you legally authorized to work in the US?',
        answer: 'Yes',
      },
    ]);
    expect(forModel).toEqual([]);
  });

  it("resolves a choice question to the form's own wording of the stored answer", () => {
    const { resolved } = splitPreparedQuestions(profile, [
      {
        fieldId: 'f1',
        question: 'Will you require sponsorship?',
        options: ['No, I will not require sponsorship', 'Yes, I will require sponsorship'],
      },
    ]);

    expect(resolved[0].answer).toBe('No, I will not require sponsorship');
  });

  it('sends a known-but-unmappable question to the model carrying the fact, rather than dropping it', () => {
    const { resolved, forModel } = splitPreparedQuestions(profile, [
      {
        fieldId: 'f1',
        question: 'Will you require sponsorship?',
        options: ['I have unrestricted work rights', 'I need employer support to work'],
      },
    ]);

    expect(resolved).toEqual([]);
    expect(forModel).toEqual([
      {
        fieldId: 'f1',
        question: 'Will you require sponsorship?',
        options: ['I have unrestricted work rights', 'I need employer support to work'],
        knownAnswer: 'No',
      },
    ]);
  });

  it('sends every question to the model when the profile predates prepared answers', () => {
    const { resolved, forModel } = splitPreparedQuestions({} as never, [
      { fieldId: 'f1', question: 'Will you require sponsorship?', options: ['Yes', 'No'] },
    ]);

    expect(resolved).toEqual([]);
    expect(forModel).toHaveLength(1);
  });

  it('leaves an unprepared question to the model with no knownAnswer attached', () => {
    const { resolved, forModel } = splitPreparedQuestions(profile, [
      { fieldId: 'f1', question: 'Why do you want to work at Acme?' },
    ]);

    expect(resolved).toEqual([]);
    expect(forModel[0].knownAnswer).toBeUndefined();
  });
});
