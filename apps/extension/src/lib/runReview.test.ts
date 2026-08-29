import { describe, expect, it } from 'vitest';
import type { PipelineRunState, PipelineStatus } from './tabStore';
import { reviewOf } from './runReview';

function run(overrides: Partial<PipelineRunState> = {}): PipelineRunState {
  return {
    runId: 'run-1',
    status: 'review',
    tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    jobPageData: { fields: [] },
    jobDescription: 'A job',
    jobInfo: null,
    tailoredResume: null,
    answers: [],
    coverage: [],
    failure: null,
    unresolvedRequiredFields: [],
    filledFieldCount: 0,
    fillOutcome: null,
    applicationId: null,
    duplicateOf: null,
    ...overrides,
  };
}

const filled = (overrides: Partial<PipelineRunState>) =>
  run({ status: 'filled', filledFieldCount: 3, fillOutcome: 'complete', ...overrides });

describe('reviewOf', () => {
  it('shows nothing at all before a run exists', () => {
    expect(reviewOf(null)).toEqual({ pill: null, canReview: false, outcome: null, notices: [] });
  });

  it('reads a run that wrote nothing as a failure, though its status says filled', () => {
    // The case the run's own `status` cannot express: every step "succeeded" because the Fill Step
    // was handed no fields at all.
    const review = reviewOf(filled({ filledFieldCount: 0, fillOutcome: 'no-fields-detected' }));

    expect(review.outcome).toBe('no-fields-detected');
    expect(review.pill).toEqual({ label: 'No form found', tone: 'error' });
  });

  it('separates a form that was never found from one that kept nothing it was given', () => {
    // Same `filledFieldCount: 0`, opposite problems — and the panel's advice differs, so these must
    // not collapse into one outcome. Here the re-scan saw the form perfectly well and the page
    // rejected every write.
    const review = reviewOf(
      filled({
        filledFieldCount: 0,
        fillOutcome: 'nothing-filled',
        jobPageData: {
          fields: [
            {
              id: 'f1',
              label: 'Full name',
              inputType: 'text',
              selector: '#f1',
              category: 'full_name',
              required: true,
              elementRole: 'native',
            },
          ],
        },
      }),
    );

    expect(review.outcome).toBe('nothing-filled');
    expect(review.pill).toEqual({ label: 'Nothing filled', tone: 'error' });
  });

  it('reads a run that left a required field unresolved as incomplete', () => {
    const review = reviewOf(
      filled({
        fillOutcome: 'incomplete',
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

  it('never reads an unanswered fill as success, regardless of its optimistic counts', () => {
    const review = reviewOf(filled({ filledFieldCount: 3, fillOutcome: 'unverified' }));

    expect(review.outcome).toBe('unverified');
    expect(review.pill).toEqual({ label: 'Fill unverified', tone: 'error' });
  });

  it('reports no outcome until the Fill Step has actually completed', () => {
    for (const status of [
      'analyzing',
      'analyze-error',
      'duplicate',
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
    const keeps: PipelineStatus[] = [
      'review',
      'filling',
      'fill-error',
      'filled',
      'saving',
      'save-error',
      'saved',
    ];
    const drops: PipelineStatus[] = ['analyzing', 'analyze-error', 'duplicate'];

    for (const status of keeps) expect(reviewOf(run({ status })).canReview).toBe(true);
    for (const status of drops) expect(reviewOf(run({ status })).canReview).toBe(false);
  });

  it('gives every status a pill, so a new one cannot silently render a blank header', () => {
    const statuses: PipelineStatus[] = [
      'analyzing',
      'analyze-error',
      'duplicate',
      'review',
      'filling',
      'fill-error',
      'filled',
      'saving',
      'save-error',
      'saved',
    ];

    for (const status of statuses) expect(reviewOf(run({ status })).pill).not.toBeNull();
  });

  it('follows the status it is given, so the pill agrees with the tab it describes', () => {
    // The reconciled status — optimistic while one stands, a delivery failure ahead of that. The
    // pill used to derive itself from the stored run instead, so for the whole gap between a click
    // and the background's own write it said "Ready to fill" over a body that said "Filling…".
    const stored = run({ status: 'review' });

    expect(reviewOf(stored, 'filling').pill).toEqual({ label: 'Filling…', tone: 'busy' });
    expect(reviewOf(stored, 'fill-error').pill).toEqual({ label: 'Error', tone: 'error' });
  });

  it('pills an optimistic status raised before any run exists to store it', () => {
    // The first Analyze on a page. An idle guard on the run rather than the status left the header
    // blank while the body already said "Analyzing…".
    expect(reviewOf(null, 'analyzing').pill).toEqual({ label: 'Analyzing…', tone: 'busy' });
  });

  it('reads a completed run through its own outcome even when the status is optimistic', () => {
    const stored = filled({ filledFieldCount: 0, fillOutcome: 'nothing-filled' });

    expect(reviewOf(stored, 'saving').pill).toEqual({ label: 'Saving...', tone: 'busy' });
    expect(reviewOf(stored, 'saving').outcome).toBe('nothing-filled');
  });
  it('raises no notice for a run that has nothing to report yet', () => {
    for (const status of ['analyzing', 'review', 'filling'] as const) {
      expect(reviewOf(run({ status })).notices).toEqual([]);
    }
  });

  it('carries the past application on the duplicate notice, so the guard cannot render without it', () => {
    const duplicateOf = {
      id: 'application-1',
      company: 'Acme',
      roleTitle: 'Engineer',
      stage: 'rejected' as const,
      createdAt: '2026-01-04T00:00:00.000Z',
      count: 2,
    };

    expect(reviewOf(run({ status: 'duplicate', duplicateOf })).notices).toEqual([
      {
        kind: 'duplicate',
        slot: 'outcome',
        tone: 'error',
        action: 'analyze-anyway',
        duplicate: duplicateOf,
      },
    ]);
  });

  it('raises no duplicate notice without the application it is about', () => {
    // The panel used to guard this by hand as `status === 'duplicate' && duplicateOf`. A notice
    // that cannot exist without its payload makes the second half of that guard structural.
    expect(reviewOf(run({ status: 'duplicate', duplicateOf: null })).notices).toEqual([]);
  });

  it('carries the cause of a failed analysis, and offers the retry', () => {
    const failure = { step: 'analysis' as const, message: 'POST /extract-job failed (500): boom' };

    expect(
      reviewOf(run({ status: 'analyze-error', failure }), 'analyze-error', failure).notices,
    ).toEqual([
      {
        kind: 'analyze-failed',
        slot: 'outcome',
        tone: 'error',
        action: 'retry-analysis',
        cause: 'POST /extract-job failed (500): boom',
      },
    ]);
  });

  it('reports a failed step whose cause never arrived, rather than nothing at all', () => {
    // A delivery failure the panel raised itself can be message-only; a malformed run can have none.
    expect(reviewOf(run({ status: 'analyze-error' })).notices).toEqual([
      {
        kind: 'analyze-failed',
        slot: 'outcome',
        tone: 'error',
        action: 'retry-analysis',
        cause: null,
      },
    ]);
  });

  it("takes the failure it is given over the run's own, so the notice agrees with the pill", () => {
    // The same reconciliation `status` gets: a delivery failure from this panel outranks whatever
    // the stored run last checkpointed. Deriving them separately is how the body once showed an
    // error the header knew nothing about.
    const stored = run({ status: 'review', failure: { step: 'fill', message: 'stale' } });
    const delivery = {
      step: 'analysis' as const,
      message: 'Could not reach the background worker',
    };

    expect(reviewOf(stored, 'analyze-error', delivery).notices).toEqual([
      {
        kind: 'analyze-failed',
        slot: 'outcome',
        tone: 'error',
        action: 'retry-analysis',
        cause: 'Could not reach the background worker',
      },
    ]);
  });

  it('reports each fill outcome as its own notice, carrying what its copy has to interpolate', () => {
    expect(reviewOf(filled({ fillOutcome: 'unverified' })).notices).toEqual([
      { kind: 'fill-unverified', slot: 'outcome', tone: 'error' },
    ]);

    expect(
      reviewOf(filled({ fillOutcome: 'no-fields-detected', filledFieldCount: 0 })).notices,
    ).toEqual([{ kind: 'no-fields-detected', slot: 'outcome', tone: 'error' }]);

    expect(reviewOf(filled({ fillOutcome: 'complete', filledFieldCount: 4 })).notices).toEqual([
      { kind: 'fill-complete', slot: 'outcome', tone: 'success', filledFieldCount: 4 },
    ]);
  });

  it("counts the fields the run's own re-scan saw on a page that kept nothing", () => {
    // What separates the two zero-filled outcomes for the reader: this page's form was found, and
    // it is the run's checkpointed scan that says how much of it there was.
    const review = reviewOf(
      filled({
        fillOutcome: 'nothing-filled',
        filledFieldCount: 0,
        jobPageData: {
          fields: [
            {
              id: 'f1',
              label: 'Full name',
              inputType: 'text',
              selector: '#f1',
              category: 'full_name',
              required: true,
              elementRole: 'native',
            },
            {
              id: 'f2',
              label: 'Email',
              inputType: 'email',
              selector: '#f2',
              category: 'email',
              required: true,
              elementRole: 'native',
            },
          ],
        },
      }),
    );

    expect(review.notices).toEqual([
      { kind: 'nothing-filled', slot: 'outcome', tone: 'error', detectedFieldCount: 2 },
    ]);
  });

  it('names the required fields an incomplete fill left unresolved', () => {
    const unresolved = [
      {
        id: 'f1',
        label: 'Work authorization',
        inputType: 'combobox',
        selector: '#f1',
        category: 'question' as const,
        required: true,
        elementRole: 'combobox' as const,
      },
    ];

    expect(
      reviewOf(filled({ fillOutcome: 'incomplete', unresolvedRequiredFields: unresolved })).notices,
    ).toEqual([
      {
        kind: 'fill-incomplete',
        slot: 'outcome',
        tone: 'error',
        unresolvedRequiredFields: unresolved,
      },
    ]);
  });

  it('replaces the completed-fill notice once the application is saved', () => {
    // "Filled 4 fields. Save the application when you're ready." is not true of a saved run, and
    // the two notices would otherwise sit one above the other saying different things.
    const review = reviewOf(
      filled({ status: 'saved', fillOutcome: 'complete', filledFieldCount: 4 }),
    );

    expect(review.notices).toEqual([{ kind: 'saved', slot: 'outcome', tone: 'success' }]);
  });

  it('keeps reporting an incomplete fill after a save, because saving did not resolve it', () => {
    // Only `complete` is superseded by saving. A required field the page rejected is still unfilled
    // on a form the candidate has yet to submit, and the save says nothing about it.
    const unresolved = [
      {
        id: 'f1',
        label: 'Work authorization',
        inputType: 'combobox',
        selector: '#f1',
        category: 'question' as const,
        required: true,
        elementRole: 'combobox' as const,
      },
    ];
    const review = reviewOf(
      filled({ status: 'saved', fillOutcome: 'incomplete', unresolvedRequiredFields: unresolved }),
    );

    expect(review.notices).toEqual([
      {
        kind: 'fill-incomplete',
        slot: 'outcome',
        tone: 'error',
        unresolvedRequiredFields: unresolved,
      },
      { kind: 'saved', slot: 'outcome', tone: 'success' },
    ]);
  });

  it('puts a step retry beside the review it is retried from, not above it', () => {
    const failure = { step: 'fill' as const, message: 'FILL_FORM failed' };
    const review = reviewOf(run({ status: 'fill-error', failure }), 'fill-error', failure);

    expect(review.notices).toEqual([
      {
        kind: 'fill-failed',
        slot: 'inline',
        tone: 'error',
        action: 'retry-fill',
        cause: 'FILL_FORM failed',
      },
    ]);
  });

  it('reports how the fill went alongside the save that failed, in that order', () => {
    // A save-error run has a completed Fill Step behind it, so both are news: the outcome above the
    // review, the retry inside it.
    const failure = { step: 'save' as const, message: 'POST /applications failed (500)' };
    const review = reviewOf(
      filled({ status: 'save-error', fillOutcome: 'complete', filledFieldCount: 4, failure }),
      'save-error',
      failure,
    );

    expect(review.notices).toEqual([
      { kind: 'fill-complete', slot: 'outcome', tone: 'success', filledFieldCount: 4 },
      {
        kind: 'save-failed',
        slot: 'inline',
        tone: 'error',
        action: 'retry-save',
        cause: 'POST /applications failed (500)',
      },
    ]);
  });

  it('gives every notice a tone the header pill would recognize', () => {
    // Notices and the pill describe the same run; a fourth register in one and not the other is how
    // a banner comes to look unlike the pill above it.
    const tones = new Set(['busy', 'success', 'error']);
    const statuses: PipelineStatus[] = [
      'analyzing',
      'analyze-error',
      'duplicate',
      'review',
      'filling',
      'fill-error',
      'filled',
      'saving',
      'save-error',
      'saved',
    ];

    for (const status of statuses) {
      const review = reviewOf(filled({ status, duplicateOf: null }));
      for (const notice of review.notices) expect(tones.has(notice.tone)).toBe(true);
    }
  });
});
