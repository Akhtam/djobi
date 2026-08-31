import type { DetectedField, QuestionAnswer } from '@djobi/shared';
import { describe, expect, it } from 'vitest';
import { answersFor } from '.';

function field(overrides: Partial<DetectedField> = {}): DetectedField {
  return {
    id: 'f1',
    label: 'Why do you want to work here?',
    inputType: 'textarea',
    selector: '#why',
    category: 'question',
    required: false,
    elementRole: 'native',
    ...overrides,
  };
}

function answer(overrides: Partial<QuestionAnswer> = {}): QuestionAnswer {
  return {
    fieldId: 'f1',
    question: 'Why do you want to work here?',
    answer: 'Because of the platform work.',
    sourceStoryIds: [],
    ...overrides,
  };
}

/** A run carrying `fields` as its *analyzed* detection, and `answers` as what was drafted for it. */
function run(fields: DetectedField[], answers: QuestionAnswer[]) {
  return { jobPageData: { fields }, answers };
}

describe('answersFor', () => {
  it('resolves an answer by field id', () => {
    const drafted = answersFor(run([field()], [answer()]));

    expect(drafted.valueFor(field())).toBe('Because of the platform work.');
  });

  /**
   * The reason the map has to come from the run's own analyzed detection rather than from whatever
   * fields the caller is resolving: a remounted element carries a new id, and the analyzed label is
   * the only thing left that identifies the question.
   */
  it('resolves a remounted field by the label it was analyzed under', () => {
    const drafted = answersFor(run([field()], [answer()]));

    expect(drafted.valueFor(field({ id: 'f9-remounted' }))).toBe('Because of the platform work.');
  });

  it('reports a question with no drafted answer as unanswered', () => {
    const unmatched = field({ id: 'f2', label: 'Do you need visa sponsorship?' });
    const drafted = answersFor(run([field()], [answer()]));

    expect(drafted.unanswered([field(), unmatched])).toEqual([unmatched]);
  });

  it('ignores fields that are not questions', () => {
    const email = field({ id: 'f3', label: 'Email', category: 'email', inputType: 'email' });

    expect(answersFor(run([field()], [answer()])).unanswered([email])).toEqual([]);
  });

  /**
   * The panel hands over the run's analyzed fields *and* its own live detection, which overlap. The
   * same question arriving from both must be listed once — it is one thing for the candidate to
   * write.
   */
  it('names an unanswered question once even when two sources report it', () => {
    const analyzed = field({ id: 'f2', label: 'Do you need visa sponsorship?' });
    const rescanned = field({ id: 'f7', label: 'Do you need visa sponsorship? ' });
    const drafted = answersFor(run([], []));

    expect(drafted.unanswered([analyzed, rescanned])).toEqual([analyzed]);
  });

  /**
   * Not symmetric with `valueFor`, and deliberately: before an Analysis Step every question is
   * trivially unanswered, and reporting that would warn the candidate about a page they have not
   * analyzed yet.
   */
  it('reports nothing unanswered when there is no run', () => {
    const drafted = answersFor(null);

    expect(drafted.valueFor(field())).toBeUndefined();
    expect(drafted.unanswered([field()])).toEqual([]);
  });
});
