/**
 * In-memory stand-in for `chrome.storage.session`, for tests.
 *
 * Like Chrome, every `set`/`remove` fires `onChanged` — including in the writing context, which
 * exercises `usePipelineRun`'s own-write echo guard — and changes carry both `oldValue` and
 * `newValue`, which `tabStore/record.ts` compares to tell which owner moved.
 */
export interface FakeStorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

type StorageListener = (changes: Record<string, FakeStorageChange>, areaName: string) => void;

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

  function notify(changes: Record<string, FakeStorageChange>) {
    // Iterate a copy: a listener that removes itself mid-notification would otherwise skip the
    // next.
    for (const listener of [...listeners]) listener(changes, 'session');
  }

  return {
    session: {
      get: (key) =>
        Promise.resolve(
          key === null ? Object.fromEntries(data) : data.has(key) ? { [key]: data.get(key) } : {},
        ),
      set: (items) => {
        const changes: Record<string, FakeStorageChange> = {};
        for (const [key, value] of Object.entries(items)) {
          changes[key] = { oldValue: data.get(key), newValue: value };
          data.set(key, value);
        }
        notify(changes);
        return Promise.resolve();
      },
      remove: (key) => {
        const oldValue = data.get(key);
        data.delete(key);
        notify({ [key]: { oldValue, newValue: undefined } });
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
