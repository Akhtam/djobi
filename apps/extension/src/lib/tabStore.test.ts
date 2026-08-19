import type { JobInfo, TailoredResume } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSessionStorage } from './fakeSessionStorage';
import {
  asAnalyzedRun,
  clearTabState,
  enrichDetectedFields,
  getDetectedPage,
  getPipelineRun,
  patchPipelineRun,
  registerTabStateCleanup,
  reportDetectedPage,
  setPipelineRun,
  storageKey,
  transitionPipelineRun,
  type PipelineRunState,
} from './tabStore';

const jobInfo: JobInfo = {
  company: 'Acme',
  team: null,
  roleTitle: 'Senior Engineer',
  seniority: 'Senior',
  location: null,
  requirements: [],
  keywords: [],
};

const tailoredResume: TailoredResume = { skills: [], workExperience: [] };

const run: PipelineRunState = {
  runId: 'run-1',
  status: 'review',
  tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
  jobPageData: { fields: [] },
  jobDescription: 'Senior Engineer at Acme...',
  jobInfo,
  tailoredResume,
  answers: [],
  failure: null,
  unresolvedRequiredFields: [],
  filledFieldCount: 0,
  fillOutcome: null,
  applicationId: null,
  duplicateOf: null,
};

function textField(id: string) {
  return {
    id,
    label: id,
    inputType: 'text',
    selector: `#${id}`,
    category: 'unknown' as const,
    required: false,
    elementRole: 'native' as const,
  };
}

/** The shared in-memory `chrome.storage.session`, plus the `chrome.tabs.onRemoved` cleanup hooks into. */
function stubChrome() {
  const onRemovedListeners: ((tabId: number) => void)[] = [];
  const onUpdatedListeners: ((tabId: number, changeInfo: { url?: string }) => void)[] = [];

  vi.stubGlobal('chrome', {
    storage: fakeSessionStorage(),
    tabs: {
      onRemoved: {
        addListener: vi.fn((listener: (tabId: number) => void) => {
          onRemovedListeners.push(listener);
        }),
      },
      onUpdated: {
        addListener: vi.fn((listener: (tabId: number, changeInfo: { url?: string }) => void) => {
          onUpdatedListeners.push(listener);
        }),
      },
    },
  });

  return {
    fireTabRemoved: (tabId: number) => onRemovedListeners.forEach((listener) => listener(tabId)),
    fireTabUpdated: (tabId: number, url: string) =>
      onUpdatedListeners.forEach((listener) => listener(tabId, { url })),
  };
}

describe('tabStore', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  describe('detected pages', () => {
    it('returns null for a tab nothing has reported for', async () => {
      stubChrome();

      expect(await getDetectedPage(999)).toBeNull();
    });

    it('returns the reported page for a tab', async () => {
      stubChrome();

      await reportDetectedPage(1, 0, { fields: [] });

      expect(await getDetectedPage(1)).toEqual({ fields: [] });
    });

    it("prefers the frame that detected the most fields, so an ATS iframe's real form isn't shadowed by a stray file input on the host page", async () => {
      stubChrome();

      // Host page (main frame) sees one stray input; the embedded ATS iframe holds the real form.
      await reportDetectedPage(1, 0, { fields: [textField('stray')] });
      await reportDetectedPage(1, 4, {
        fields: [textField('first_name'), textField('email'), textField('phone')],
      });

      // The iframe's three fields beat the host page's one stray input.
      expect((await getDetectedPage(1))?.fields).toHaveLength(3);
    });

    it('keeps frames independent, so a later report from one frame does not erase another', async () => {
      stubChrome();

      await reportDetectedPage(1, 4, {
        fields: [textField('a'), textField('b')],
      });
      await reportDetectedPage(1, 0, { fields: [] });

      expect((await getDetectedPage(1))?.fields).toHaveLength(2);
    });

    it('applies an API-oracle enrichment to the frame it was fetched for', async () => {
      stubChrome();
      const reportedAt = await reportDetectedPage(1, 0, {
        fields: [textField('a')],
      });

      await enrichDetectedFields(1, 0, reportedAt, [textField('a'), textField('enriched')]);

      expect((await getDetectedPage(1))?.fields.map((f) => f.id)).toEqual(['a', 'enriched']);
    });

    it('drops a stale enrichment whose frame has been re-reported since — a slow API response for a page we navigated away from must not overwrite fresher detection', async () => {
      stubChrome();
      const staleReportedAt = await reportDetectedPage(1, 0, {
        fields: [textField('old')],
      });
      await reportDetectedPage(1, 0, { fields: [textField('new')] });

      await enrichDetectedFields(1, 0, staleReportedAt, [textField('enriched-from-old-posting')]);

      expect((await getDetectedPage(1))?.fields.map((f) => f.id)).toEqual(['new']);
    });
  });

  describe('pipeline run', () => {
    it('returns null for a tab with no run', async () => {
      stubChrome();

      expect(await getPipelineRun(999)).toBeNull();
    });

    it('round-trips a run', async () => {
      stubChrome();

      await setPipelineRun(1, run);

      expect(await getPipelineRun(1)).toEqual(run);
    });

    it("keeps different tabs' runs independent", async () => {
      stubChrome();

      await setPipelineRun(1, run);
      await setPipelineRun(2, { ...run, status: 'filled' });

      expect(await getPipelineRun(1)).toEqual(run);
      expect(await getPipelineRun(2)).toMatchObject({ status: 'filled' });
    });

    it('merges a patch onto an existing run', async () => {
      stubChrome();
      await setPipelineRun(1, run);

      expect(await patchPipelineRun(1, run.runId, { status: 'filled' })).toBe(true);

      expect(await getPipelineRun(1)).toEqual({ ...run, status: 'filled' });
    });

    it('does nothing when patching a tab with no run', async () => {
      stubChrome();

      expect(await patchPipelineRun(1, run.runId, { status: 'filled' })).toBe(false);

      expect(await getPipelineRun(1)).toBeNull();
    });

    it('does nothing when patching a different run', async () => {
      stubChrome();
      await setPipelineRun(1, run);

      expect(await patchPipelineRun(1, 'superseded-run', { status: 'filled' })).toBe(false);

      expect(await getPipelineRun(1)).toEqual(run);
    });

    it('lets only one concurrent operation claim an allowed status', async () => {
      stubChrome();
      await setPipelineRun(1, { ...run, status: 'review' });

      const [first, second] = await Promise.all([
        transitionPipelineRun(1, ['review'], { status: 'filling' }),
        transitionPipelineRun(1, ['review'], { status: 'filling' }),
      ]);

      expect([first, second].filter(Boolean)).toHaveLength(1);
      expect(await getPipelineRun(1)).toMatchObject({ status: 'filling' });
    });

    it('stores a run and a detected page side by side, without either clobbering the other', async () => {
      stubChrome();

      await reportDetectedPage(1, 0, { fields: [textField('email')] });
      await setPipelineRun(1, run);

      expect((await getDetectedPage(1))?.fields).toHaveLength(1);
      expect(await getPipelineRun(1)).toEqual(run);
    });
  });

  /**
   * `chrome.storage.session` outlives an extension reload, so an entry can have been written by a
   * different build than the one reading it. These pin the parse that makes that survivable.
   */
  describe('surviving a version skew across an extension reload', () => {
    /** Writes `entry` straight into storage, bypassing the store's own writers. */
    async function seedRaw(tabId: number, entry: unknown) {
      await chrome.storage.session.set({ [storageKey(tabId)]: entry });
    }

    it('applies schema defaults to a field written before `required` and `elementRole` existed', async () => {
      stubChrome();
      await seedRaw(7, {
        frames: {
          '0': {
            revision: 1,
            data: {
              fields: [
                {
                  id: 'f1',
                  label: 'Email',
                  inputType: 'email',
                  selector: '#f1',
                  category: 'email',
                },
              ],
            },
          },
        },
        run: null,
      });

      expect((await getDetectedPage(7))?.fields[0]).toMatchObject({
        id: 'f1',
        required: false,
        elementRole: 'native',
      });
    });

    it('drops a field that no longer fits the schema, keeping the rest of the form', async () => {
      stubChrome();
      await seedRaw(7, {
        frames: {
          '0': {
            revision: 1,
            data: {
              fields: [
                { id: 'stale', category: 'a-category-this-build-does-not-have' },
                {
                  id: 'f2',
                  label: 'Email',
                  inputType: 'email',
                  selector: '#f2',
                  category: 'email',
                },
              ],
            },
          },
        },
        run: null,
      });

      expect((await getDetectedPage(7))?.fields.map((f) => f.id)).toEqual(['f2']);
    });

    it('tolerates an entry whose frames key is missing entirely', async () => {
      stubChrome();
      await seedRaw(7, { run: null });

      expect(await getDetectedPage(7)).toBeNull();
    });

    it('conservatively marks a completed run from before fill outcomes were persisted as unverified', async () => {
      stubChrome();
      const { fillOutcome: _fillOutcome, ...legacyRun } = run;
      await seedRaw(7, { frames: {}, run: { ...legacyRun, status: 'filled' } });

      expect(await getPipelineRun(7)).toMatchObject({
        status: 'filled',
        fillOutcome: 'unverified',
      });
    });
  });

  describe('asAnalyzedRun', () => {
    it('narrows a run whose Analysis Step has completed', () => {
      expect(asAnalyzedRun(run)).toBe(run);
    });

    it('rejects a run still missing its Analysis Step results', () => {
      expect(asAnalyzedRun(null)).toBeNull();
      expect(asAnalyzedRun({ ...run, jobInfo: null })).toBeNull();
      expect(asAnalyzedRun({ ...run, tailoredResume: null })).toBeNull();
    });
  });

  it('clears everything for a tab at once', async () => {
    stubChrome();
    await reportDetectedPage(1, 0, { fields: [] });
    await setPipelineRun(1, run);

    await clearTabState(1);

    expect(await getDetectedPage(1)).toBeNull();
    expect(await getPipelineRun(1)).toBeNull();
  });

  it("clears a tab's state when the tab closes, once cleanup is registered — the old in-memory store leaked an entry per tab visited", async () => {
    const { fireTabRemoved } = stubChrome();
    registerTabStateCleanup();
    await setPipelineRun(1, run);

    fireTabRemoved(1);
    await Promise.resolve();

    expect(await getPipelineRun(1)).toBeNull();
  });

  it('clears frames and a review run when the same tab navigates to a new URL', async () => {
    const { fireTabUpdated } = stubChrome();
    registerTabStateCleanup();
    await reportDetectedPage(1, 0, { fields: [textField('email')] });
    await setPipelineRun(1, run);

    fireTabUpdated(1, 'https://example.com/another-job');
    await vi.waitFor(async () => expect(await getPipelineRun(1)).toBeNull());

    expect(await getDetectedPage(1)).toBeNull();
  });
});
