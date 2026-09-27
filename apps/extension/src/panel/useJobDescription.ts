/**
 * The Job Description the candidate would analyze for the current page. Before a run it's an
 * editable draft, mirrored to `lib/tabStore/jobContext.ts` so it survives the panel closing; once
 * analysis starts, the run's `jobDescription` is authoritative. Scoped by **Job Key**, so the draft
 * survives overview → application navigation.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { isHttpUrl } from '@djobi/shared';
import { jobKeyForUrl, type JobDescriptionSource } from '../lib/jobContext';
import { notify } from '../lib/messages';
import { chromePageClient, type PostingReadOutcome } from '../lib/pageClient';
import { canEditRun } from '../lib/run';
import { getJobContext } from '../lib/tabStore/jobContext';
import type { ActiveRun } from './useActiveRun';

/** The pre-analysis draft, scoped to the tab and job it was written for. */
interface LocalDraft {
  tabId: number;
  jobKey: string | null;
  sourceUrl: string;
  text: string;
  source: JobDescriptionSource;
}

/** Where the scrape has got to. `'not-found'` and `'unavailable'` need different advice. */
export type ScrapeStatus =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success' }
  | { kind: 'error'; reason: 'not-found' | 'unavailable' };

export interface JobDescription {
  /**
   * What to show and what Analyze sends: the run's text once there is a run, the draft before it.
   */
  text: string;
  /** Where the draft came from, or `null`. Only about the draft. */
  source: JobDescriptionSource | null;
  /**
   * The URL an analysis belongs to: the run's, else where the draft was collected, else the tracked
   * tab. `null` unless http(s) — a saved Application needs one, so Analyze stays disabled.
   */
  analysisUrl: string | null;
  scrapeStatus: ScrapeStatus;
  /** Whether {@link scrape} would do anything — the same rule the button's `disabled` needs. */
  canScrape: boolean;
  /** Records the candidate's text, onto the run if there is one and into the draft otherwise. */
  edit: (value: string) => void;
  /** Reads the posting out of the page into the draft, for the candidate to review. */
  scrape: () => void;
}

export function useJobDescription(
  activeRun: ActiveRun,
  readPosting: (tabId: number) => Promise<PostingReadOutcome> = chromePageClient.readPosting,
): JobDescription {
  const { tabId, tabUrl, changeToken, run, status, edit: editRun } = activeRun;

  const [draft, setDraft] = useState<LocalDraft | null>(null);
  const [scrapeStatus, setScrapeStatus] = useState<ScrapeStatus>({ kind: 'idle' });
  // Supersedes an in-flight scrape whose page is no longer the one being shown.
  const scrapeRequestRef = useRef(0);
  // Advances on every write to the draft, so a scrape can tell whether the candidate typed while it
  // was reading the page.
  const draftRevisionRef = useRef(0);

  const jobKey = jobKeyForUrl(tabUrl);
  const currentDraft = draft?.tabId === tabId && draft.jobKey === jobKey ? draft : null;

  // Page-scoped reset, plus the restore that isn't: a draft for the same job survives a navigation
  // between that job's routes, and is re-read from the store for a panel that was closed.
  useEffect(() => {
    if (tabId === null) return;
    const activeTabId = tabId;

    setScrapeStatus({ kind: 'idle' });
    ++scrapeRequestRef.current;
    setDraft((existing) =>
      existing?.tabId === tabId && existing.jobKey === jobKey ? existing : null,
    );

    let current = true;
    void getJobContext(activeTabId).then((context) => {
      if (!current || context?.jobKey !== jobKey) return;
      // Never over the draft already in hand: it is the newer of the two, since every edit is
      // applied locally before being mirrored to the store.
      setDraft((existing) =>
        existing?.tabId === activeTabId && existing.jobKey === jobKey
          ? existing
          : {
              tabId: activeTabId,
              jobKey: context.jobKey,
              sourceUrl: context.sourceUrl,
              text: context.jobDescription,
              source: context.source,
            },
      );
    });

    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- route identity is the reset signal
  }, [tabId, tabUrl, changeToken]);

  const edit = useCallback(
    (value: string) => {
      if (!canEditRun(status)) return;

      if (run) {
        editRun({ answers: run.answers, jobDescription: value });
        return;
      }
      if (tabId === null || !tabUrl) return;

      ++draftRevisionRef.current;
      const sourceUrl = currentDraft?.sourceUrl ?? tabUrl;
      const source = currentDraft?.source ?? 'manual';
      setDraft({ tabId, jobKey, sourceUrl, text: value, source });
      notify({
        type: 'UPDATE_JOB_CONTEXT',
        tabId,
        tabUrl: sourceUrl,
        jobDescription: value,
        source,
      });
      setScrapeStatus((previous) => (previous.kind === 'idle' ? previous : { kind: 'idle' }));
    },
    [currentDraft, editRun, jobKey, run, status, tabId, tabUrl],
  );

  const text = run ? run.jobDescription : (currentDraft?.text ?? '');
  const canScrape =
    tabId !== null && Boolean(tabUrl) && !text.trim() && scrapeStatus.kind !== 'loading';

  const scrape = useCallback(() => {
    if (tabId === null || !tabUrl || !canScrape) return;

    const request = ++scrapeRequestRef.current;
    const draftRevision = draftRevisionRef.current;
    setScrapeStatus({ kind: 'loading' });

    void (async () => {
      let outcome: PostingReadOutcome;
      try {
        outcome = await readPosting(tabId);
      } catch {
        if (request === scrapeRequestRef.current) {
          setScrapeStatus({ kind: 'error', reason: 'unavailable' });
        }
        return;
      }
      if (request !== scrapeRequestRef.current) return;

      // The candidate can keep typing while the content script scans; their text always wins.
      if (draftRevision !== draftRevisionRef.current) {
        setScrapeStatus({ kind: 'idle' });
        return;
      }

      if (outcome.status !== 'success') {
        setScrapeStatus({ kind: 'error', reason: outcome.status });
        return;
      }

      ++draftRevisionRef.current;
      setDraft({
        tabId,
        jobKey,
        sourceUrl: tabUrl,
        text: outcome.candidate.text,
        source: 'scraped',
      });
      notify({
        type: 'UPDATE_JOB_CONTEXT',
        tabId,
        tabUrl,
        jobDescription: outcome.candidate.text,
        source: 'scraped',
      });
      setScrapeStatus({ kind: 'success' });
    })();
  }, [canScrape, jobKey, readPosting, tabId, tabUrl]);

  return {
    text,
    source: currentDraft?.source ?? null,
    analysisUrl: httpUrlOrNull(run?.tabUrl ?? currentDraft?.sourceUrl ?? tabUrl),
    scrapeStatus,
    canScrape,
    edit,
    scrape,
  };
}

function httpUrlOrNull(url: string | null | undefined): string | null {
  return url && isHttpUrl(url) ? url : null;
}
