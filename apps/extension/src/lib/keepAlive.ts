/**
 * Keeps the MV3 service worker alive for the duration of an operation it is awaiting.
 *
 * Chrome stops an extension service worker after ~30 seconds of inactivity, and **a pending `fetch`
 * is not activity** — only receiving an event or calling an extension API resets that timer. The
 * Application Pipeline is built almost entirely out of long `fetch` calls to the local backend, so
 * a step that outlives the timer is stopped mid-flight: the request is aborted (the backend logs it
 * as a 499), nothing is checkpointed, and the panel is left on `analyzing` with no error and no
 * retry.
 *
 * That was reachable the moment the Analysis Step got slower. `extractJob` plus the longer of
 * `tailorResume` and `answerQuestions` measured ~27s against providers that reason before they
 * answer, which is close enough to 30 that whether a run survives depends on the posting.
 *
 * So the heartbeat is a real extension API call on a timer — the only thing Chrome counts. It is
 * `getPlatformInfo` because it reads nothing, changes nothing and needs no permission.
 *
 * **This does not make the worker immortal, and nothing here may start relying on it.** Chrome may
 * still stop a worker for reasons that have nothing to do with idleness, so every rule under _MV3
 * durability_ stands exactly as it did: the run is still checkpointed at each stage, and a new
 * worker still repairs what its predecessor abandoned. This narrows how often that repair is
 * needed; it is not permission to stop checkpointing.
 */

/** Comfortably inside Chrome's ~30s idle limit, and cheap enough that the margin costs nothing. */
const HEARTBEAT_MS = 20_000;

/**
 * How many operations are currently being kept alive.
 *
 * Refcounted rather than one timer per call so overlapping operations share one heartbeat without
 * allowing the first completion to clear a beat another operation still needs.
 */
let active = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function beat(): void {
  // Fire-and-forget: the answer is irrelevant, the *call* is the whole point. A rejection would
  // mean the worker is already going away, which is not something to log per beat.
  void chrome.runtime.getPlatformInfo().catch(() => undefined);
}

/**
 * Runs `task`, holding the worker awake until it settles.
 *
 * @param task - The operation to keep the worker alive for.
 * @returns Whatever `task` resolves to; its rejection propagates unchanged.
 */
export async function withWorkerKeptAlive<T>(task: () => Promise<T>): Promise<T> {
  if (active++ === 0) timer = setInterval(beat, HEARTBEAT_MS);
  try {
    return await task();
  } finally {
    if (--active === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }
}
