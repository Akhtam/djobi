import { describe, expect, it } from 'vitest';
import {
  PIPELINE_STATUSES,
  STEP_STATUS,
  canEditRun,
  canFill,
  canReview,
  canSave,
  hasFilled,
  hasRecordedFill,
  isBusy,
  startableFrom,
  type PipelineStatus,
} from './status';

const BUSY: PipelineStatus[] = ['analyzing', 'filling', 'saving'];
const REVIEWABLE: PipelineStatus[] = [
  'review',
  'filling',
  'fill-error',
  'filled',
  'saving',
  'save-error',
  'saved',
];
const FILLED: PipelineStatus[] = ['filled', 'saving', 'save-error', 'saved'];
const FILLABLE: PipelineStatus[] = ['review', 'fill-error', 'filled', 'save-error', 'saved'];
const SAVEABLE: PipelineStatus[] = ['filled', 'save-error'];

describe('run status policy', () => {
  it('enumerates every status in progression order', () => {
    expect(PIPELINE_STATUSES).toEqual([
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
    ]);
  });

  it.each(PIPELINE_STATUSES)('derives all capabilities for %s from one table', (status) => {
    expect(isBusy(status)).toBe(BUSY.includes(status));
    expect(canReview(status)).toBe(REVIEWABLE.includes(status));
    expect(hasFilled(status)).toBe(FILLED.includes(status));
    expect(canFill(status)).toBe(FILLABLE.includes(status));
    expect(canSave(status)).toBe(SAVEABLE.includes(status));
    expect(canEditRun(status)).toBe(status !== 'saving');
    expect(hasRecordedFill(status)).toBe(status === 'saved');
  });

  it('derives atomic claim source statuses from the same capabilities', () => {
    expect(startableFrom('analysis')).toEqual(PIPELINE_STATUSES);
    expect(startableFrom('fill')).toEqual(FILLABLE);
    expect(startableFrom('save')).toEqual(SAVEABLE);
  });

  it('owns every step status triplet', () => {
    expect(STEP_STATUS).toEqual({
      analysis: { running: 'analyzing', succeeded: 'review', failed: 'analyze-error' },
      fill: { running: 'filling', succeeded: 'filled', failed: 'fill-error' },
      save: { running: 'saving', succeeded: 'saved', failed: 'save-error' },
    });
  });
});
