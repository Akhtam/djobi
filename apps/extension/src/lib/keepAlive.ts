/**
 * Keeps the MV3 service worker alive while it awaits an operation.
 *
 * Chrome stops an idle worker after ~30s, and **a pending `fetch` isn't activity** — only events
 * and extension API calls are. Analysis can approach that limit, so a timer calls `getPlatformInfo`
 * (reads nothing, needs no permission) as a heartbeat.
 *
 * Not immortality: Chrome can still stop the worker, so runs are still checkpointed and a new
 * worker still repairs abandoned steps.
 */

/** Comfortably inside Chrome's ~30s idle limit, and cheap enough that the margin costs nothing. */
const HEARTBEAT_MS = 20_000;

/** Operations currently kept alive; refcounted so overlapping operations share one heartbeat. */
let active = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function beat(): void {
  // Fire-and-forget: the answer is irrelevant, the *call* is the whole point. A rejection would
  // mean the worker is already going away, which is not something to log per beat.
  void chrome.runtime.getPlatformInfo().catch(() => undefined);
}

/**
 * Runs `task`, holding the worker awake until it settles. Its result or rejection passes through.
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
