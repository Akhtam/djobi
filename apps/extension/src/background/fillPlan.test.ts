import type { DetectedField } from '@djobi/shared';
import { describe, expect, it } from 'vitest';
import { asAnalyzedRun } from '../lib/run';
import { pipelineRunFixture, profile } from '../lib/testFixtures';
import { fillReport, planFill, type FillPlan } from './fillPlan';

const question: DetectedField = {
  id: 'f-why',
  label: 'Why do you want to work here?',
  inputType: 'textarea',
  selector: '#why',
  category: 'question',
  required: true,
  elementRole: 'native',
};
const email: DetectedField = {
  id: 'f-email',
  label: 'Email',
  inputType: 'email',
  selector: '#email',
  category: 'email',
  required: true,
  elementRole: 'native',
};
const resume: DetectedField = {
  id: 'f-resume',
  label: 'Resume',
  inputType: 'file',
  selector: '#resume',
  category: 'resume_upload',
  required: true,
  elementRole: 'native',
};

const run = asAnalyzedRun(
  pipelineRunFixture({
    jobPageData: { fields: [question, email] },
    answers: [
      { fieldId: 'f-why', question: question.label, answer: 'Because.', sourceStoryIds: [] },
    ],
  }),
)!;

describe('planFill', () => {
  it("fills the fresh scan's elements with the analyzed run's answers and the Profile", () => {
    // The page re-rendered: new ids, and the question lost the `required` flag the analysis saw.
    const rescanned = [
      { ...question, id: 'f-why-2', selector: '#why-2', required: false },
      { ...email, id: 'f-email-2' },
      resume,
    ];

    const plan = planFill(run, rescanned, profile);

    expect(plan.fields.map((field) => field.id)).toEqual(['f-why-2', 'f-email-2', 'f-resume']);
    expect(plan.fields[0]!.required).toBe(true);
    expect(plan.values).toEqual({ 'f-why-2': 'Because.', 'f-email-2': profile.email });
    expect(plan.needsResume).toBe(true);
  });

  it("falls back to the run's own detection when the page could not be re-scanned", () => {
    const plan = planFill(run, null, profile);

    expect(plan.fields).toEqual([question, email]);
    expect(plan.needsResume).toBe(false);
  });

  it('leaves a question the run drafted no answer for blank rather than blocking the fill', () => {
    const unseen = { ...question, id: 'f-new', label: 'Anything else?' };

    expect(planFill(run, [unseen], profile).values).toEqual({});
  });
});

describe('fillReport', () => {
  const plan: FillPlan = {
    fields: [question, email, resume],
    values: { 'f-why': 'Because.', 'f-email': profile.email },
    needsResume: true,
  };

  it('is complete when the page kept every value and the resume', () => {
    expect(
      fillReport(
        plan,
        { ok: true, filledFieldIds: ['f-why', 'f-email', 'f-resume'], resumeAttached: true },
        true,
      ),
    ).toEqual({ unresolvedRequiredFields: [], filledFieldCount: 3, fillOutcome: 'complete' });
  });

  it('names a required field the page discarded', () => {
    expect(
      fillReport(plan, { ok: true, filledFieldIds: ['f-why'], resumeAttached: true }, true),
    ).toEqual({
      unresolvedRequiredFields: [email],
      filledFieldCount: 2,
      fillOutcome: 'incomplete',
    });
  });

  it('reports nothing filled when the page kept none of it', () => {
    expect(
      fillReport(plan, { ok: true, filledFieldIds: [], resumeAttached: false }, true),
    ).toMatchObject({ filledFieldCount: 0, fillOutcome: 'nothing-filled' });
  });

  it('counts what was sent, but calls it unverified, when no frame answered', () => {
    expect(fillReport(plan, null, true)).toEqual({
      unresolvedRequiredFields: [],
      filledFieldCount: 3,
      fillOutcome: 'unverified',
    });
  });

  it('says no fields were detected rather than reporting an empty success', () => {
    expect(
      fillReport(
        { fields: [], values: {}, needsResume: false },
        { ok: true, filledFieldIds: [], resumeAttached: false },
        false,
      ),
    ).toEqual({
      unresolvedRequiredFields: [],
      filledFieldCount: 0,
      fillOutcome: 'no-fields-detected',
    });
  });
});
