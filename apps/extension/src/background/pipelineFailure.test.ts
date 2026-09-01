import { describe, expect, it } from 'vitest';
import { HttpError } from '../lib/callBackend';
import { PageResponseError } from '../lib/pageClient';
import { pipelineFailure } from './pipelineFailure';

describe('pipelineFailure', () => {
  it('maps safe backend model-output codes independently of raw provider wording', () => {
    const error = new HttpError('http', '/answer-questions', 'private provider details', 500, {
      backendCode: 'invalid-model-output',
    });

    expect(pipelineFailure('analysis', error)).toEqual({
      step: 'analysis',
      kind: 'invalid-model-output',
    });
  });

  it.each([
    [new HttpError('http', '/extract-job', 'Authentication required', 401), 'unauthorized'],
    [new HttpError('network', '/extract-job', 'failed to fetch'), 'backend-unreachable'],
    [new HttpError('timeout', '/extract-job', 'timed out'), 'temporary'],
    [new HttpError('http', '/extract-job', 'retry later', 408), 'temporary'],
    [new HttpError('http', '/extract-job', 'retry later', 425), 'temporary'],
    [new HttpError('http', '/extract-job', 'retry later', 429), 'temporary'],
    [new HttpError('http', '/extract-job', 'retry later', 503), 'temporary'],
    [new PageResponseError('SCAN_PAGE'), 'invalid-page'],
  ] as const)('maps %s to %s', (error, kind) => {
    expect(pipelineFailure('analysis', error)).toEqual({ step: 'analysis', kind });
  });

  it('maps explicit and signal-driven cancellation before other classifications', () => {
    const controller = new AbortController();
    controller.abort();

    expect(pipelineFailure('fill', new Error('superseded'), controller.signal)).toEqual({
      step: 'fill',
      kind: 'cancelled',
    });
    expect(pipelineFailure('fill', new DOMException('Aborted', 'AbortError'))).toEqual({
      step: 'fill',
      kind: 'cancelled',
    });
  });

  it('uses unknown for non-retryable and unrecognized failures', () => {
    expect(
      pipelineFailure('save', new HttpError('http', '/applications', 'bad request', 400)),
    ).toEqual({
      step: 'save',
      kind: 'unknown',
    });
    expect(pipelineFailure('save', new Error('unexpected implementation fault'))).toEqual({
      step: 'save',
      kind: 'unknown',
    });
  });
});
