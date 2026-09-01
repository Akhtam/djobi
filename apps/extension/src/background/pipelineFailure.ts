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
    // The session in `chrome.storage.session` expired, or `signOut` cleared it, since this step
    // started — `docs/multi-tenant-auth.md`, Phase D. Distinguished from the generic `'unknown'`
    // below because the fix is specific (sign in again) rather than "try again," and the panel's
    // own `failureReason` says so.
    if (error.kind === 'http' && error.status === 401) return { step, kind: 'unauthorized' };
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
