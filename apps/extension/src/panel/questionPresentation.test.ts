import { describe, expect, it } from 'vitest';
import type { DetectedField } from '@djobi/shared';
import type { JobPageData } from '../lib/messages';
import type { FillOutcome, PipelineRunState } from '../lib/run';
import { questionPresentation } from './questionPresentation';

function field(overrides: Partial<DetectedField> = {}): DetectedField {
  return {
    id: 'field-1',
    label: 'Why do you want to work here?',
    inputType: 'textarea',
    selector: '#why',
    category: 'question',
    required: false,
    elementRole: 'native',
    ...overrides,
  };
}

function page(fields: DetectedField[]): JobPageData {
  return { fields };
}

function run(overrides: Partial<PipelineRunState> = {}): PipelineRunState {
  return {
    runId: 'run-1',
    status: 'review',
    tabUrl: 'https://example.com/jobs/1',
    jobPageData: page([]),
    jobDescription: '',
    analyzedJobDescription: '',
    jobInfo: null,
    tailoredResume: null,
    answers: [],
    coverage: [],
    failure: null,
    unresolvedRequiredFields: [],
    fillOutcome: null,
    filledFieldCount: 0,
    applicationId: null,
    duplicateOf: null,
    ...overrides,
  };
}

describe('questionPresentation', () => {
  it('refines only native, optionless question fields', () => {
    const nativeQuestion = field({ id: 'q1', category: 'question' });
    const select = field({
      id: 'q2',
      category: 'question',
      options: [{ label: 'Yes', selector: null }],
    });
    const combobox = field({ id: 'q3', category: 'question', elementRole: 'combobox' });
    const profileField = field({ id: 'p1', category: 'full_name' });

    const result = questionPresentation(
      run({ jobPageData: page([nativeQuestion, select, combobox, profileField]) }),
      null,
      null,
    );

    expect(result.refinableFieldIds).toEqual(new Set(['q1']));
  });

  it('the run snapshot wins for refinable ids once one exists, over the live detection', () => {
    const fromRun = field({ id: 'from-run', category: 'question' });
    const fromLive = field({ id: 'from-live', category: 'question' });

    const result = questionPresentation(
      run({ jobPageData: page([fromRun]) }),
      page([fromLive]),
      null,
    );

    expect(result.refinableFieldIds).toEqual(new Set(['from-run']));
  });

  it('falls back to live detection for refinable ids before any run exists', () => {
    const fromLive = field({ id: 'from-live', category: 'question' });

    const result = questionPresentation(null, page([fromLive]), null);

    expect(result.refinableFieldIds).toEqual(new Set(['from-live']));
  });

  it('unfilledQuestions merges the run and live detection, de-duplicated by label', () => {
    const answered = field({ id: 'answered', label: 'Answered already' });
    const onlyInRun = field({ id: 'in-run', label: 'Only in run' });
    const onlyLive = field({ id: 'in-live', label: 'Only live' });
    const repeatedAcrossBoth = field({ id: 'repeated', label: 'Repeated question' });

    const withRun = run({
      jobPageData: page([answered, onlyInRun, repeatedAcrossBoth]),
      answers: [
        { fieldId: 'answered', question: 'Answered already', answer: 'Yes', sourceStoryIds: [] },
      ],
    });

    const result = questionPresentation(withRun, page([repeatedAcrossBoth, onlyLive]), null);

    expect(result.unfilledQuestions.map((f) => f.id).sort()).toEqual(
      ['in-live', 'in-run', 'repeated'].sort(),
    );
  });

  it('unfilledQuestions is empty with no run — nothing has been analyzed to leave unanswered', () => {
    const result = questionPresentation(null, page([field()]), null);

    expect(result.unfilledQuestions).toEqual([]);
  });

  it('unfilledRequiredQuestions narrows to the required ones only', () => {
    const optional = field({ id: 'optional', label: 'Optional question', required: false });
    const required = field({ id: 'required', label: 'Required question', required: true });

    const result = questionPresentation(
      run({ jobPageData: page([optional, required]) }),
      null,
      null,
    );

    expect(result.unfilledRequiredQuestions.map((f) => f.id)).toEqual(['required']);
  });

  it('hasNewApplicationQuestions is true only before Fill has reported and something is unfilled', () => {
    const withUnfilled = run({ jobPageData: page([field()]) });

    expect(questionPresentation(withUnfilled, null, null).hasNewApplicationQuestions).toBe(true);

    const outcomes: FillOutcome[] = ['unverified', 'no-fields-detected', 'complete', 'incomplete'];
    for (const outcome of outcomes) {
      expect(questionPresentation(withUnfilled, null, outcome).hasNewApplicationQuestions).toBe(
        false,
      );
    }
  });

  it('hasNewApplicationQuestions is false with nothing unfilled, regardless of outcome', () => {
    const noQuestions = run({ jobPageData: page([]) });

    expect(questionPresentation(noQuestions, null, null).hasNewApplicationQuestions).toBe(false);
  });
});
