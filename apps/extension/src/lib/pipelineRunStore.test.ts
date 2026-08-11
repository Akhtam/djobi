import type { JobInfo, TailoredResume } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPipelineRun,
  getPipelineRun,
  patchPipelineRun,
  registerPipelineRunCleanup,
  setPipelineRun,
  type PipelineRunState,
} from './pipelineRunStore';

const jobPageData = { pageText: 'Senior Engineer at Acme...', fields: [] };

const jobInfo: JobInfo = {
  company: 'Acme',
  team: null,
  roleTitle: 'Senior Engineer',
  seniority: 'Senior',
  location: null,
  requirements: [],
  keywords: [],
};

const tailoredResume: TailoredResume = {
  summary: 'Tailored summary.',
  skills: [],
  workExperience: [],
};

const run: PipelineRunState = {
  status: 'review',
  tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
  jobPageData,
  pageTextOverride: null,
  jobInfo,
  tailoredResume,
  answers: [],
  unresolvedRequiredFields: [],
};

/** In-memory stand-in for `chrome.storage.session`, close enough to the real callback/Promise API for these tests. */
function stubSessionStorage() {
  const data = new Map<string, unknown>();
  const onRemovedListeners: ((tabId: number) => void)[] = [];

  vi.stubGlobal('chrome', {
    storage: {
      session: {
        get: vi.fn((key: string) => Promise.resolve(data.has(key) ? { [key]: data.get(key) } : {})),
        set: vi.fn((items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) data.set(key, value);
          return Promise.resolve();
        }),
        remove: vi.fn((key: string) => {
          data.delete(key);
          return Promise.resolve();
        }),
      },
    },
    tabs: {
      onRemoved: {
        addListener: vi.fn((listener: (tabId: number) => void) => {
          onRemovedListeners.push(listener);
        }),
      },
    },
  });

  return { data, fireTabRemoved: (tabId: number) => onRemovedListeners.forEach((l) => l(tabId)) };
}

describe('pipelineRunStore', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null for a tab with no stored run', async () => {
    stubSessionStorage();

    expect(await getPipelineRun(999)).toBeNull();
  });

  it('returns the run previously stored for a tab', async () => {
    stubSessionStorage();

    await setPipelineRun(1, run);

    expect(await getPipelineRun(1)).toEqual(run);
  });

  it("keeps different tabs' runs independent", async () => {
    stubSessionStorage();

    await setPipelineRun(1, run);
    await setPipelineRun(2, { ...run, status: 'filled' });

    expect(await getPipelineRun(1)).toEqual(run);
    expect(await getPipelineRun(2)).toMatchObject({ status: 'filled' });
  });

  it('merges a patch onto an existing run', async () => {
    stubSessionStorage();
    await setPipelineRun(1, run);

    await patchPipelineRun(1, { status: 'filled' });

    expect(await getPipelineRun(1)).toEqual({ ...run, status: 'filled' });
  });

  it('does nothing when patching a tab with no existing run', async () => {
    stubSessionStorage();

    await patchPipelineRun(1, { status: 'filled' });

    expect(await getPipelineRun(1)).toBeNull();
  });

  it('removes the stored run for a tab', async () => {
    stubSessionStorage();
    await setPipelineRun(1, run);

    await clearPipelineRun(1);

    expect(await getPipelineRun(1)).toBeNull();
  });

  it("clears a tab's run when the tab closes, once cleanup is registered", async () => {
    const { fireTabRemoved } = stubSessionStorage();
    registerPipelineRunCleanup();
    await setPipelineRun(1, run);

    fireTabRemoved(1);
    await Promise.resolve();

    expect(await getPipelineRun(1)).toBeNull();
  });
});
