/**
 * In-memory stand-in for `chrome.storage.session`, for tests. Not imported by anything that ships.
 *
 * There were four hand-rolled copies of this — one per test file that touches `tabStore.ts` — and
 * they had drifted: two fired `onChanged`, one didn't fire it at all while claiming in a comment to
 * match one that did, and one stubbed `remove` as a no-op. Since `onChanged` is how the panel learns
 * that the background made progress, a fake that doesn't fire it can only ever test half the store.
 *
 * Mirrors the real API closely enough for `tabStore.ts` and `panel/usePipelineRun.ts`: `get`/`set`/
 * `remove` are promise-based, and every `set`/`remove` notifies listeners — including the context
 * that made the write, exactly as Chrome does, which is what exercises the hook's own-write echo
 * guard rather than just its hydrate-on-mount path.
 */
type StorageListener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => void;

export interface FakeSessionStorage {
  session: {
    get: (key: string | null) => Promise<Record<string, unknown>>;
    set: (items: Record<string, unknown>) => Promise<void>;
    remove: (key: string) => Promise<void>;
  };
  onChanged: {
    addListener: (listener: StorageListener) => void;
    removeListener: (listener: StorageListener) => void;
  };
}

/** A fresh, empty store. Assign it to `chrome.storage` — the shape matches. */
export function fakeSessionStorage(): FakeSessionStorage {
  const data = new Map<string, unknown>();
  const listeners: StorageListener[] = [];

  function notify(changes: Record<string, { newValue?: unknown }>) {
    // Iterate a copy: a listener that removes itself mid-notification would otherwise skip the next.
    for (const listener of [...listeners]) listener(changes, 'session');
  }

  return {
    session: {
      get: (key) =>
        Promise.resolve(
          key === null ? Object.fromEntries(data) : data.has(key) ? { [key]: data.get(key) } : {},
        ),
      set: (items) => {
        const changes: Record<string, { newValue?: unknown }> = {};
        for (const [key, value] of Object.entries(items)) {
          changes[key] = { newValue: value };
          data.set(key, value);
        }
        notify(changes);
        return Promise.resolve();
      },
      remove: (key) => {
        data.delete(key);
        notify({ [key]: { newValue: undefined } });
        return Promise.resolve();
      },
    },
    onChanged: {
      addListener: (listener) => {
        listeners.push(listener);
      },
      removeListener: (listener) => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
    },
  };
}
