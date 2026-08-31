import { HttpError } from '../lib/callBackend';
import { PageResponseError } from '../lib/pageClient';
import type { PipelineFailure, RunStep } from '../lib/run';

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  );
}

/** Maps infrastructure failures once into the smaller vocabulary stored on a run. */
export function pipelineFailure(
  step: RunStep,
  error: unknown,
  signal?: AbortSignal,
): PipelineFailure {
  if (signal?.aborted || isAbortError(error)) return { step, kind: 'cancelled' };
  if (error instanceof PageResponseError) return { step, kind: 'invalid-page' };

  if (error instanceof HttpError) {
    if (error.backendCode === 'invalid-model-output') {
      return { step, kind: 'invalid-model-output' };
    }
    if (error.kind === 'network') return { step, kind: 'backend-unreachable' };
    if (error.kind === 'timeout') return { step, kind: 'temporary' };
    if (
      error.kind === 'http' &&
      (error.status === 408 ||
        error.status === 425 ||
        error.status === 429 ||
        (error.status ?? 0) >= 500)
    ) {
      return { step, kind: 'temporary' };
    }
  }

  return { step, kind: 'unknown' };
}
