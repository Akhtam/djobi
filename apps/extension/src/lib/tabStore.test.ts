import type { JobInfo, TailoredResume } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  status: 'review',
  tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
  jobPageData: { pageText: 'Senior Engineer at Acme...', fields: [] },
  pageTextOverride: null,
  jobInfo,
  tailoredResume,
  answers: [],
  failure: null,
  unresolvedRequiredFields: [],
  filledFieldCount: 0,
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

/** In-memory stand-in for `chrome.storage.session`, close enough to the real Promise API here. */
function stubChrome() {
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

  return { fireTabRemoved: (tabId: number) => onRemovedListeners.forEach((l) => l(tabId)) };
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

      await reportDetectedPage(1, 0, { pageText: 'Senior Engineer at Acme', fields: [] });

      expect(await getDetectedPage(1)).toEqual({ pageText: 'Senior Engineer at Acme', fields: [] });
    });

    it("prefers the frame that detected the most fields, so an ATS iframe's real form isn't shadowed by a stray file input on the host page", async () => {
      stubChrome();

      // Host page (main frame) sees one stray input; the embedded ATS iframe holds the real form.
      await reportDetectedPage(1, 0, { pageText: 'Careers at Acme', fields: [textField('stray')] });
      await reportDetectedPage(1, 4, {
        pageText: 'Senior Engineer at Acme',
        fields: [textField('first_name'), textField('email'), textField('phone')],
      });

      expect(await getDetectedPage(1)).toMatchObject({ pageText: 'Senior Engineer at Acme' });
    });

    it('keeps frames independent, so a later report from one frame does not erase another', async () => {
      stubChrome();

      await reportDetectedPage(1, 4, {
        pageText: 'the real form',
        fields: [textField('a'), textField('b')],
      });
      await reportDetectedPage(1, 0, { pageText: 'host page', fields: [] });

      expect(await getDetectedPage(1)).toMatchObject({ pageText: 'the real form' });
    });

    it('applies an API-oracle enrichment to the frame it was fetched for', async () => {
      stubChrome();
      const reportedAt = await reportDetectedPage(1, 0, {
        pageText: 'Senior Engineer at Acme',
        fields: [textField('a')],
      });

      await enrichDetectedFields(1, 0, reportedAt, [textField('a'), textField('enriched')]);

      expect((await getDetectedPage(1))?.fields.map((f) => f.id)).toEqual(['a', 'enriched']);
    });

    it('drops a stale enrichment whose frame has been re-reported since — a slow API response for a page we navigated away from must not overwrite fresher detection', async () => {
      stubChrome();
      const staleReportedAt = await reportDetectedPage(1, 0, {
        pageText: 'the old posting',
        fields: [textField('old')],
      });
      await reportDetectedPage(1, 0, { pageText: 'the new posting', fields: [textField('new')] });

      await enrichDetectedFields(1, 0, staleReportedAt, [textField('enriched-from-old-posting')]);

      expect(await getDetectedPage(1)).toMatchObject({ pageText: 'the new posting' });
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

      await patchPipelineRun(1, { status: 'filled' });

      expect(await getPipelineRun(1)).toEqual({ ...run, status: 'filled' });
    });

    it('does nothing when patching a tab with no run', async () => {
      stubChrome();

      await patchPipelineRun(1, { status: 'filled' });

      expect(await getPipelineRun(1)).toBeNull();
    });

    it('stores a run and a detected page side by side, without either clobbering the other', async () => {
      stubChrome();

      await reportDetectedPage(1, 0, { pageText: 'Senior Engineer at Acme', fields: [] });
      await setPipelineRun(1, run);

      expect(await getDetectedPage(1)).toMatchObject({ pageText: 'Senior Engineer at Acme' });
      expect(await getPipelineRun(1)).toEqual(run);
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
    await reportDetectedPage(1, 0, { pageText: 'Senior Engineer at Acme', fields: [] });
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
});
