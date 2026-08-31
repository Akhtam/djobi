import type { JobInfo, TailoredResume } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeChrome } from '../fakeChrome';
import { enrichDetectedFields, getDetectedPage, reportDetectedPage } from './detectedPage';
import { getJobContext, setJobContext } from './jobContext';
import { clearTabState, registerTabStateCleanup } from './lifecycle';
import { asAnalyzedRun } from '../run';
import {
  getPipelineRun,
  patchPipelineRun,
  recoverInterruptedPipelineRuns,
  setPipelineRun,
  subscribePipelineRun,
  transitionPipelineRun,
  type PipelineRunChange,
} from './pipelineRun';
import { seedLegacyTabState } from './testing';
import { pipelineRunFixture } from '../testFixtures';

const run = pipelineRunFixture();

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
  const { closeTab, navigate } = fakeChrome();
  return { fireTabRemoved: closeTab, fireTabUpdated: navigate };
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

    it('writes nothing when the oracle enriched nothing, so a report costs one storage event', async () => {
      // The usual case: no oracle recognizes the URL, or the fetch failed, and the fields come back
      // exactly as they went in. Every write to this key is an event each panel subscriber has to
      // interpret, and doing it twice per report for no change is what made the panel's optimistic
      // status so easy to knock over.
      stubChrome();
      const fields = [textField('a')];
      const reportedAt = await reportDetectedPage(1, 0, { fields });

      let writes = 0;
      chrome.storage.onChanged.addListener(() => {
        writes += 1;
      });
      await enrichDetectedFields(1, 0, reportedAt, [textField('a')]);

      expect(writes).toBe(0);
      expect((await getDetectedPage(1))?.fields.map((f) => f.id)).toEqual(['a']);
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

    it('classifies shared-record writes at the run subscription seam', async () => {
      stubChrome();
      await setPipelineRun(1, run);
      const changes: PipelineRunChange[] = [];
      const unsubscribe = subscribePipelineRun(1, (change) => changes.push(change));

      await reportDetectedPage(1, 0, { fields: [] });
      await patchPipelineRun(1, run.runId, { jobDescription: 'Edited by the panel' });
      await patchPipelineRun(1, run.runId, { status: 'filling' });

      expect(changes).toEqual([
        expect.objectContaining({
          previous: run,
          current: run,
          progressMoved: false,
          pageStateMoved: true,
        }),
        expect.objectContaining({ progressMoved: false, pageStateMoved: false }),
        expect.objectContaining({ progressMoved: true, pageStateMoved: false }),
      ]);
      unsubscribe();
    });

    it('recovers operations abandoned by an earlier service-worker instance without touching idle runs', async () => {
      stubChrome();
      await setPipelineRun(1, { ...run, status: 'analyzing', jobInfo: null, tailoredResume: null });
      await setPipelineRun(2, { ...run, runId: 'run-2', status: 'filling' });
      await setPipelineRun(3, { ...run, runId: 'run-3', status: 'saving' });
      await setPipelineRun(4, { ...run, runId: 'run-4', status: 'review' });

      await recoverInterruptedPipelineRuns();

      expect(await getPipelineRun(1)).toMatchObject({
        status: 'analyze-error',
        failure: {
          step: 'analysis',
          kind: 'temporary',
        },
      });
      expect(await getPipelineRun(2)).toMatchObject({
        status: 'fill-error',
        failure: {
          step: 'fill',
          kind: 'temporary',
        },
      });
      expect(await getPipelineRun(3)).toMatchObject({
        status: 'save-error',
        failure: {
          step: 'save',
          kind: 'temporary',
        },
      });
      expect(await getPipelineRun(4)).toEqual({ ...run, runId: 'run-4', status: 'review' });
    });
  });

  /**
   * `chrome.storage.session` outlives an extension reload, so an entry can have been written by a
   * different build than the one reading it. These pin the parse that makes that survivable.
   */
  describe('surviving a version skew across an extension reload', () => {
    /** Seeds the persisted shape from an older build, bypassing this build's writers. */
    async function seedRaw(tabId: number, entry: unknown) {
      await seedLegacyTabState(tabId, entry);
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

    /**
     * The other half of that rule. `unverified` is a statement about a fill that happened, so a
     * legacy run that never reached one must not carry it — the panel would report an unverified
     * fill on a run still waiting to be filled.
     */
    it('leaves a legacy run that never filled without an outcome at all', async () => {
      stubChrome();
      const { fillOutcome: _fillOutcome, ...legacyRun } = run;
      await seedRaw(7, { frames: {}, run: { ...legacyRun, status: 'review' } });

      expect(await getPipelineRun(7)).toMatchObject({ status: 'review', fillOutcome: null });
    });

    it('normalizes a legacy message-only failure without retaining its raw detail', async () => {
      stubChrome();
      await seedRaw(7, {
        frames: {},
        run: {
          ...run,
          status: 'analyze-error',
          failure: {
            step: 'analysis',
            message: 'provider internals that must not reach the panel',
          },
        },
      });

      expect(await getPipelineRun(7)).toMatchObject({
        failure: { step: 'analysis', kind: 'unknown' },
      });
      expect((await getPipelineRun(7))?.failure).not.toHaveProperty('message');
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
    await setJobContext(1, run.tabUrl!, run.jobDescription, 'scraped');
    await setPipelineRun(1, run);

    await clearTabState(1);

    expect(await getDetectedPage(1)).toBeNull();
    expect(await getJobContext(1)).toBeNull();
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

  it('retains the Job Description and run while Ashby moves the same job to /application', async () => {
    const { fireTabUpdated } = stubChrome();
    registerTabStateCleanup();
    const overviewUrl = 'https://jobs.ashbyhq.com/acme/job-id';
    await reportDetectedPage(1, 0, { fields: [textField('overview-field')] });
    await setJobContext(1, overviewUrl, 'Retained Ashby description', 'scraped');
    await setPipelineRun(1, { ...run, tabUrl: overviewUrl });

    fireTabUpdated(1, `${overviewUrl}/application`);
    await vi.waitFor(async () => expect(await getDetectedPage(1)).toBeNull());

    expect(await getJobContext(1)).toMatchObject({
      sourceUrl: overviewUrl,
      jobDescription: 'Retained Ashby description',
    });
    expect(await getPipelineRun(1)).toMatchObject({ tabUrl: overviewUrl });
  });

  /**
   * Clearing the editor removes the context rather than storing an empty draft. An empty one would
   * be restored over whatever the candidate does next — the panel reads a stored draft back on
   * mount — so "I deleted this" would come back as "I have a blank draft for this job".
   */
  it('removes a retained draft when the candidate empties the editor', async () => {
    stubChrome();
    const url = 'https://jobs.ashbyhq.com/acme/job-1';
    await setJobContext(1, url, 'A description worth keeping', 'scraped');

    await setJobContext(1, url, '   ', 'manual');

    expect(await getJobContext(1)).toBeNull();
  });

  /**
   * A URL with no posting identity cannot scope a draft to a job, and storing one under a key that
   * doesn't identify anything would restore it onto an unrelated page.
   */
  it('stores nothing for a URL no Job Key can be derived from', async () => {
    stubChrome();

    await setJobContext(1, 'not-a-url', 'A description', 'manual');

    expect(await getJobContext(1)).toBeNull();
  });

  it('clears a retained draft when navigation identifies a different job', async () => {
    const { fireTabUpdated } = stubChrome();
    registerTabStateCleanup();
    await setJobContext(1, 'https://jobs.ashbyhq.com/acme/job-1', 'Job one', 'scraped');

    fireTabUpdated(1, 'https://jobs.ashbyhq.com/acme/job-2');
    await vi.waitFor(async () => expect(await getJobContext(1)).toBeNull());
  });
});
