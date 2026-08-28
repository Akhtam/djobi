import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getPipelineRun,
  storageKey as tabStorageKey,
  type PipelineFailure,
  type PipelineRunState,
  type PipelineStatus,
  type TabState,
} from '../lib/tabStore';
import { notify } from '../lib/messages';

/**
 * Keeps one tab's Application Pipeline run in sync with `lib/tabStore.ts`, and owns the status the
 * panel renders.
 *
 * The panel used to hold each of the run's fields in its own `useState` and reassemble them by hand
 * in three places — the initial read, the write-back, and the storage subscription. Every one of
 * those had to list every field, so adding a single field to the run meant ten edits across five
 * files, and omitting one of the three sites still compiled. Here the run moves as one value and a
 * new field costs nothing.
 *
 * Ownership is deliberately lopsided: **the background service worker serializes every persisted
 * mutation and owns operational progress** (Analysis results, failures and fill counts). This hook
 * owns optimistic typed edits and may request the associated `saved` → `filled` reset, but never
 * writes storage directly.
 *
 * `status` is nonetheless computed here rather than in the component, because it is assembled from
 * four sources — the stored run, an optimistic value, a delivery failure, and the fact that a store
 * update has arrived — and only some of those are the component's business. Keeping the rest out of
 * the interface is what removed `syncedAt`: a counter the panel had to receive and hang a
 * `useEffect` on purely so an optimistic status knew when to stand down.
 *
 * All four are reconciled *here*, into the single `status`/`failure` pair every reader renders. They
 * used to be reconciled twice and differently — the Autofill Tab held the delivery failure and
 * layered it over the optimistic status, while the shell's header pill derived itself from the
 * stored run alone — so for the whole gap between a click and the background's own write the pill
 * said "Ready to fill" while the body and footer said "Filling…". One run has one meaning; this is
 * where it is decided. See {@link begin} and {@link fail}.
 */
export interface PipelineRunHandle {
  /**
   * The stored run for this tab, or `null` when nothing has been analyzed on it yet — or when the
   * one that is stored isn't a run this caller `accepts`.
   */
  run: PipelineRunState | null;
  /**
   * What the panel should render: a delivery failure ahead of everything, then the optimistic status
   * while one is standing, then the stored run's, and `null` before anything has been analyzed on
   * this tab.
   */
  status: PipelineStatus | null;
  /**
   * Why the current step failed: a delivery failure from this panel if one stands, the run's own
   * checkpointed cause otherwise, and `null` when nothing has failed.
   *
   * Paired with `status` deliberately — the two always describe the same failure, and reconciling
   * them separately is how the tab body once showed a delivery error the header pill knew nothing
   * about.
   */
  failure: PipelineFailure | null;
  /**
   * Whether the initial read for the current tab has completed.
   *
   * The panel doesn't render this — it renders `run` and `status`, both of which read as "nothing
   * yet" until the read lands, so it has nothing to wait for. It is here for tests, which need a
   * precise barrier to await before asserting: without it they would have to wait on the *effect*
   * of hydration and would pass or fail on timing. An affordance that exists only for the test
   * surface is still part of the interface, so it's stated rather than quietly present.
   */
  hydrated: boolean;
  /**
   * Shows `status` immediately, until the background answers for the step it was raised for.
   *
   * For the gap between a click and the background writing its own status — without it the UI sits
   * unchanged long enough for the user to click twice. Never persisted. Also clears any standing
   * delivery failure: a new command is starting, so the last one's is no longer the news.
   *
   * "Until the background answers" is narrower than it used to be, and deliberately. This stood
   * down on *any* write to the tab's storage key — but that key holds the tab's detected frames and
   * its Job Context as well as the run, and the content script re-reports on every DOM change the
   * form makes. So a frame report, an API-oracle enrichment, a Job Description keystroke or a
   * same-job navigation each dropped the optimism and snapped the panel back to "Ready to fill"
   * mid-click. It now stands down only for a write that is actually the background answering; see
   * {@link answersTheCommand}.
   */
  begin: (status: PipelineStatus) => void;
  /**
   * Records that a command never reached the service worker, standing the optimistic status down.
   *
   * `notify` reports whether Chrome managed to *deliver* a START, and an undelivered one produces no
   * run and no storage event at all — so without this the tab spins forever on a step nothing is
   * running. Panel-local and never persisted: the background never learned of the step, so there is
   * nothing on the run to correct.
   */
  fail: (status: 'analyze-error' | 'fill-error' | 'save-error', failure: PipelineFailure) => void;
  /** Persists the user's edits, updating `run` immediately so typing stays responsive. */
  edit: (
    edits: Pick<PipelineRunState, 'answers' | 'jobDescription'> & { status?: 'filled' },
  ) => void;
}

/** The subset this hook is allowed to write — see the ownership note on {@link PipelineRunHandle}. */
function editsOf(run: PipelineRunState): Pick<PipelineRunState, 'answers' | 'jobDescription'> {
  return { answers: run.answers, jobDescription: run.jobDescription };
}

/**
 * Structural equality, stopping at the first difference and allocating nothing.
 *
 * `JSON.stringify` on either side said the same thing in one line, but it *serializes* both: the
 * page-scoped half holds every Detected Field of every frame, and the run carries the tailored
 * resume, the requirement fit and the coverage report. This hook is called for every write to its
 * tab's key and the content script re-reports on each DOM mutation the form makes, so on a large ATS
 * form that was hundreds of KB of string built and thrown away per event, on the panel's main
 * thread. Reference equality is not an option in its place: `oldValue` and `newValue` reach a
 * `chrome.storage.onChanged` listener separately deserialized, so nothing unchanged shares identity.
 *
 * Both sides come from `JSON.parse`, so there are no `undefined` members, no cycles and no
 * non-plain objects to account for.
 */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => same(item, b[index]));
  }

  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  const right = b as Record<string, unknown>;
  return keys.every((key) => key in right && same((a as Record<string, unknown>)[key], right[key]));
}

/** The page-scoped half of a tab's entry: everything under its key that is not the run. */
function pageStateOf(state: TabState | undefined): object {
  return { frames: state?.frames ?? {}, jobContext: state?.jobContext ?? null };
}

/** The half of the run the *background* owns — everything but this hook's own optimistic edits. */
function progressOf(run: PipelineRunState | null | undefined): object | null {
  if (!run) return null;
  const { answers: _answers, jobDescription: _jobDescription, ...progress } = run;
  return progress;
}

/**
 * Whether a storage event is the background answering for the step an optimistic status was raised
 * for — which is when that status has served its purpose and should stand down.
 *
 * Decided from the event's own `oldValue`/`newValue`, so it needs no baseline of its own and cannot
 * be confused by the order events arrive in. Three simpler rules were each tried and are each wrong:
 *
 * - "any write to the tab's key" — what this replaces, and the bug. The key holds the tab's detected
 *   frames and its Job Context as well as the run, and the content script re-reports on every DOM
 *   change the form makes. A frame report, an API-oracle enrichment or a Job Description keystroke
 *   would each drop the optimism and snap the panel back mid-click.
 * - "the run changed" — an edit echo is a write to the run, so typing in the Job Description editor
 *   during a fill dropped the optimism just as a frame report did.
 * - "the status changed" — a second Fill Step ends on `filled` having started from `filled`, so the
 *   status never changes and an optimistic `filling` would stand forever. That is the whole reason a
 *   `syncedAt` counter used to be exported.
 *
 * So the question is not "did anything change" but "did anything change that *this panel* is not
 * already accounting for": a write that moved only the page-scoped half belongs to the content
 * script, and one that moved only the fields this hook itself just sent is its own echo. Anything
 * else — including a background write that happens to be byte-identical — is the answer we waited
 * for. Note the asymmetry: the two exemptions are recognized positively, so an event this function
 * cannot classify stands the optimism down rather than leaving the panel spinning.
 */
function answersTheCommand(change: chrome.storage.StorageChange, isOwnEditEcho: boolean): boolean {
  const before = change.oldValue as TabState | undefined;
  const after = change.newValue as TabState | undefined;
  // First, and on its own: a moved progress half settles the question without the page half — the
  // more expensive of the two comparisons — ever being walked.
  if (!same(progressOf(before?.run), progressOf(after?.run))) return true;

  const pageStateMoved = !same(pageStateOf(before), pageStateOf(after));
  return !pageStateMoved && !isOwnEditEcho;
}

/**
 * @param accepts - Whether a stored run is one this caller will show. Defaults to every run.
 *
 *   Here rather than applied to the returned `run`, because the four sources `status` reconciles are
 *   not all rejected together: a run belonging to a different job says nothing about this one, but
 *   an optimistic status and a delivery failure were raised by *this* panel for a command it just
 *   sent, and remain the news whatever the store still holds. Filtering afterwards discards those
 *   with it — a `fail('analyze-error', …)` for an undelivered START, raised in the window before
 *   the service worker's navigation cleanup lands, would leave the panel showing no spinner and no
 *   error at all.
 */
export function usePipelineRun(
  tabId: number | null,
  scopeToken: unknown = tabId,
  accepts: (run: PipelineRunState) => boolean = () => true,
): PipelineRunHandle {
  const [run, setRun] = useState<PipelineRunState | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [pending, setPending] = useState<PipelineStatus | null>(null);
  const [dispatch, setDispatch] = useState<{
    status: 'analyze-error' | 'fill-error' | 'save-error';
    failure: PipelineFailure;
  } | null>(null);
  const scopeTokenRef = useRef(scopeToken);
  // Advances whenever a store event supersedes the snapshot captured by an in-flight initial read.
  const revisionRef = useRef(0);

  // The edits last persisted, serialized. Storage echoes every write back through `onChanged`,
  // including this hook's own; without this the echo would be applied and written straight back out.
  const lastSyncedEditsRef = useRef<string | null>(null);
  // Every optimistic edit sent but not yet echoed back, oldest first — a *queue*, not the newest
  // one alone. `edit` fires per keystroke and the background answers each separately, so two
  // keystrokes inside one storage round-trip leave the first's echo arriving while the second is
  // still outstanding. Against a single latest value that echo matches nothing, and is read as the
  // background answering: the optimistic status stands down mid-fill, which is the bug this
  // reconciliation exists to fix, one keystroke narrower.
  const pendingEditsRef = useRef<string[]>([]);

  useEffect(() => {
    if (tabId === null) return;

    let current = true;
    const revision = ++revisionRef.current;
    scopeTokenRef.current = scopeToken;
    setHydrated(false);
    setRun(null);
    setPending(null);
    setDispatch(null);
    lastSyncedEditsRef.current = null;
    pendingEditsRef.current = [];

    void getPipelineRun(tabId).then((stored) => {
      // A scope change or newer storage event must not let this older snapshot replace live state.
      if (!current || revision !== revisionRef.current) return;
      if (stored) lastSyncedEditsRef.current = JSON.stringify(editsOf(stored));
      setRun(stored);
      setHydrated(true);
    });

    return () => {
      current = false;
    };
  }, [scopeToken, tabId]);

  // Keeps the run live as `background/applicationPipeline.ts` checkpoints progress into the store.
  useEffect(() => {
    if (tabId === null) return;
    const key = tabStorageKey(tabId);

    function onChanged(changes: Record<string, chrome.storage.StorageChange>, areaName: string) {
      if (areaName !== 'session' || !(key in changes)) return;

      ++revisionRef.current;
      const incoming = (changes[key].newValue as TabState | undefined)?.run ?? null;
      const incomingEdits = incoming ? JSON.stringify(editsOf(incoming)) : null;
      const pendingEdits = pendingEditsRef.current;
      // The oldest send this echo could be answering. Oldest rather than any, because an undo can
      // repeat an earlier value verbatim and the queue drains in the order it was filled.
      const echoed = incomingEdits === null ? -1 : pendingEdits.indexOf(incomingEdits);
      const isOwnEditEcho = echoed !== -1;
      // Only the *last* pending send leaves the store agreeing with what the user sees; an echo for
      // an earlier one is already stale by the time it lands.
      const caughtUp = echoed === pendingEdits.length - 1;

      setRun((currentRun) => {
        // Preserve a newer local value while an older edit echo works through the background queue.
        if (
          incoming &&
          currentRun?.runId === incoming.runId &&
          pendingEdits.length > 0 &&
          !caughtUp
        ) {
          return { ...incoming, ...editsOf(currentRun) };
        }
        return incoming;
      });
      // Drop everything up to and including the send this echo answers: those can never be matched
      // again, and leaving them would make a repeated value match an already-answered entry.
      if (isOwnEditEcho) pendingEditsRef.current = pendingEdits.slice(echoed + 1);
      lastSyncedEditsRef.current = incomingEdits;
      setHydrated(true);

      // The background has answered for the step, rather than merely written to the tab's key, so
      // the optimistic status has served its purpose — stand it down here, where the update actually
      // arrives. See {@link answersTheCommand} for why this is the test and the simpler ones are not.
      if (answersTheCommand(changes[key], isOwnEditEcho)) {
        setPending(null);
        // Any persisted progress supersedes a panel-local delivery error from the command that
        // requested it. Usually an undelivered command produces no storage event at all; this covers
        // the narrower race where Chrome reports an error as a worker is coming back.
        setDispatch(null);
      }
    }

    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [scopeToken, tabId]);

  const edit = useCallback(
    (edits: Pick<PipelineRunState, 'answers' | 'jobDescription'> & { status?: 'filled' }) => {
      if (tabId === null || !run) return;

      // Apply locally first so a controlled textarea doesn't lag a storage round-trip.
      setRun((prev) => (prev ? { ...prev, ...edits } : prev));

      const serialized = JSON.stringify({
        answers: edits.answers,
        jobDescription: edits.jobDescription,
      });
      // An undo can equal the last server echo while a different local edit is still pending. It
      // must still be sent, otherwise that older pending edit eventually wins on the server.
      if (
        serialized === lastSyncedEditsRef.current &&
        pendingEditsRef.current.length === 0 &&
        edits.status === undefined
      ) {
        return;
      }
      pendingEditsRef.current = [...pendingEditsRef.current, serialized];
      notify({ type: 'UPDATE_RUN', tabId, runId: run.runId, updates: edits });
    },
    [run, tabId],
  );

  const begin = useCallback((status: PipelineStatus) => {
    setDispatch(null);
    setPending(status);
  }, []);

  const fail = useCallback(
    (status: 'analyze-error' | 'fill-error' | 'save-error', failure: PipelineFailure) => {
      setPending(null);
      setDispatch({ status, failure });
    },
    [],
  );

  // Effects reset the state after a scope change; hide it during that render as well.
  const scopeIsCurrent = scopeTokenRef.current === scopeToken;
  const storedRun = scopeIsCurrent ? run : null;
  const visibleRun = storedRun && accepts(storedRun) ? storedRun : null;
  return {
    run: visibleRun,
    status: scopeIsCurrent ? (dispatch?.status ?? pending ?? visibleRun?.status ?? null) : null,
    failure: scopeIsCurrent ? (dispatch?.failure ?? visibleRun?.failure ?? null) : null,
    hydrated: scopeIsCurrent && hydrated,
    begin,
    fail,
    edit,
  };
}
