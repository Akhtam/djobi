import { describe, expect, it } from 'vitest';
import type { PipelineRunState, PipelineStatus } from './tabStore';
import { reviewOf } from './runReview';

function run(overrides: Partial<PipelineRunState> = {}): PipelineRunState {
  return {
    status: 'review',
    tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    jobPageData: { fields: [] },
    jobDescription: 'A job',
    jobInfo: null,
    tailoredResume: null,
    answers: [],
    failure: null,
    unresolvedRequiredFields: [],
    filledFieldCount: 0,
    ...overrides,
  };
}

const filled = (overrides: Partial<PipelineRunState>) =>
  run({ status: 'filled', filledFieldCount: 3, ...overrides });

describe('reviewOf', () => {
  it('shows nothing at all before a run exists', () => {
    expect(reviewOf(null)).toEqual({ pill: null, canReview: false, outcome: null });
  });

  it('reads a run that wrote nothing as a failure, though its status says filled', () => {
    // The case the run's own `status` cannot express: every step "succeeded" because the Fill Step
    // was handed no fields at all.
    const review = reviewOf(filled({ filledFieldCount: 0 }));

    expect(review.outcome).toBe('nothing-filled');
    expect(review.pill).toEqual({ label: 'Nothing filled', tone: 'error' });
  });

  it('reads a run that left a required field unresolved as incomplete', () => {
    const review = reviewOf(
      filled({
        unresolvedRequiredFields: [
          {
            id: 'f1',
            label: 'Work authorization',
            inputType: 'combobox',
            selector: '#f1',
            category: 'question',
            required: true,
            elementRole: 'combobox',
          },
        ],
      }),
    );

    expect(review.outcome).toBe('incomplete');
    expect(review.pill).toEqual({ label: 'Incomplete', tone: 'error' });
  });

  it('reads a run that filled everything as complete', () => {
    const review = reviewOf(filled({}));

    expect(review.outcome).toBe('complete');
    expect(review.pill).toEqual({ label: 'Done', tone: 'success' });
  });

  it('reports no outcome until the Fill Step has actually completed', () => {
    for (const status of [
      'analyzing',
      'analyze-error',
      'review',
      'filling',
      'fill-error',
    ] as const) {
      expect(reviewOf(run({ status })).outcome).toBeNull();
    }
  });

  it('keeps the review up from the moment there is something to review until well past filling it', () => {
    // 'filled' included deliberately — the user still needs the answers and the editor in front of
    // them to fix anything the page rejected.
    const keeps: PipelineStatus[] = ['review', 'filling', 'fill-error', 'filled'];
    const drops: PipelineStatus[] = ['analyzing', 'analyze-error'];

    for (const status of keeps) expect(reviewOf(run({ status })).canReview).toBe(true);
    for (const status of drops) expect(reviewOf(run({ status })).canReview).toBe(false);
  });

  it('gives every status a pill, so a new one cannot silently render a blank header', () => {
    const statuses: PipelineStatus[] = [
      'analyzing',
      'analyze-error',
      'review',
      'filling',
      'fill-error',
      'filled',
    ];

    for (const status of statuses) expect(reviewOf(run({ status })).pill).not.toBeNull();
  });
});
