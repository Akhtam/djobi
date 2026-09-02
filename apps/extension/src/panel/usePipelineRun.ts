import { useCallback, useEffect, useRef, useState } from 'react';
import type { TailoredResume } from '@djobi/shared';
import {
  type PipelineFailure,
  type PipelineRunState,
  type PipelineStatus,
  type RunStep,
  isBusy,
  panelEditsOf,
  STEP_STATUS,
} from '../lib/run';
import { getPipelineRun, subscribePipelineRun } from '../lib/tabStore/pipelineRun';
import { notify } from '../lib/messages';

/**
 * How often an in-progress run is checked on.
 *
 * Long enough that a healthy step is barely pinged, short enough that a stranded panel clears
 * within a few seconds of someone looking at it. The check costs one message and no storage read.
 */
const RUN_CHECK_MS = 15_000;

/**
 * Keeps one tab's Application Pipeline run in sync with `lib/tabStore/pipelineRun.ts`, and owns the
 * status the panel renders.
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
 * where it is decided. See {@link PipelineRunHandle.beginCommand}.
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
   * Raises `step`'s running status immediately, and hands back **that attempt's** way to stand it
   * back down.
   *
   * One call rather than the `begin`/`fail` pair it replaces, because the two were only ever
   * correct together: raising `filling` and reporting `save-error` were independent calls that
   * type-checked fine, and every caller restated the same three facts (which status means running,
   * which means failed, which step to name). Now a caller names the step and nothing else.
   *
   * The optimistic status covers the gap between a click and the background writing its own — the
   * UI would otherwise sit unchanged long enough for the user to click twice. Never persisted.
   * Raising one also clears any standing delivery failure: a new command is starting, so the last
   * one's is no longer the news.
   *
   * The returned callback records that *this* command never reached the service worker. `notify`
   * reports whether Chrome managed to deliver a START, and an undelivered one produces no run and
   * no storage event at all — so without it the tab spins forever on a step nothing is running.
   * It is **attempt-scoped**: a delivery error that arrives after a newer command has been raised
   * is discarded, where a shared `fail` would stand the newer command's status down and report an
   * error for a step that is still running.
   *
   * "Until the background answers" is narrower than it used to be, and deliberately. The status
   * stood down on *any* write to the tab's storage key — but that key holds the tab's detected
   * frames and its Job Context as well as the run, and the content script re-reports on every DOM
   * change the form makes. So a frame report, an API-oracle enrichment, a Job Description keystroke
   * or a same-job navigation each dropped the optimism and snapped the panel back to "Ready to
   * fill" mid-click. It now stands down only for a write that is actually the background answering;
   * see {@link answersTheCommand}.
   */
  beginCommand: (step: RunStep) => (message: string) => void;
  /**
   * Persists the user's edits, updating `run` immediately so typing stays responsive.
   *
   * `tailoredResume` is optional, unlike `answers`/`jobDescription`: an answers-only edit must not
   * resend the whole resume on every keystroke, and omitting the key (never sending it as
   * `undefined`) is what lets `patchPipelineRun`'s partial merge leave the stored resume alone.
   */
  edit: (
    edits: Pick<PipelineRunState, 'answers' | 'jobDescription'> & {
      tailoredResume?: TailoredResume;
      status?: 'filled';
    },
  ) => void;
}

/**
 * Whether a storage event is the background answering for the step an optimistic status was raised
 * for — which is when that status has served its purpose and should stand down.
 *
 * The store derives both movement flags from the event's own `oldValue`/`newValue`, so this needs no
 * baseline of its own and cannot be confused by the order events arrive in. Three simpler rules were
 * each tried and are each wrong:
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
function answersTheCommand(
  progressMoved: boolean,
  pageStateMoved: boolean,
  isOwnEditEcho: boolean,
) {
  if (progressMoved) return true;
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
  const [pending, setPending] = useState<PipelineStatus | null>(null);
  const [dispatch, setDispatch] = useState<{
    status: 'analyze-error' | 'fill-error' | 'save-error';
    failure: PipelineFailure;
  } | null>(null);
  const scopeTokenRef = useRef(scopeToken);
  // Advances whenever a store event supersedes the snapshot captured by an in-flight initial read.
  const revisionRef = useRef(0);
  // Which command this panel most recently raised — see {@link PipelineRunHandle.beginCommand}.
  const attemptRef = useRef(0);

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

  // The *stored* status, not the reconciled one the caller renders: an optimistic status stands for
  // a step this panel has only just requested, which is not yet something that can be interrupted.
  const storedStatus = run?.status ?? null;

  useEffect(() => {
    if (tabId === null) return;

    let current = true;
    const revision = ++revisionRef.current;
    scopeTokenRef.current = scopeToken;
    setRun(null);
    setPending(null);
    setDispatch(null);
    // The page changed under whatever command was outstanding; its delivery error is not this
    // page's news.
    ++attemptRef.current;
    lastSyncedEditsRef.current = null;
    pendingEditsRef.current = [];

    void getPipelineRun(tabId).then((stored) => {
      // A scope change or newer storage event must not let this older snapshot replace live state.
      if (!current || revision !== revisionRef.current) return;
      if (stored) lastSyncedEditsRef.current = JSON.stringify(panelEditsOf(stored));
      setRun(stored);
    });

    return () => {
      current = false;
    };
  }, [scopeToken, tabId]);

  // Keeps the run live as `background/applicationPipeline.ts` checkpoints progress into the store.
  //
  // The store owns the key, record projection, and movement flags. This hook only decides whether
  // that classified write answers its current command — see {@link answersTheCommand}.
  useEffect(() => {
    if (tabId === null) return;

    return subscribePipelineRun(tabId, ({ current: incoming, progressMoved, pageStateMoved }) => {
      ++revisionRef.current;
      const incomingEdits = incoming ? JSON.stringify(panelEditsOf(incoming)) : null;
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
          return { ...incoming, ...panelEditsOf(currentRun) };
        }
        return incoming;
      });
      // Drop everything up to and including the send this echo answers: those can never be matched
      // again, and leaving them would make a repeated value match an already-answered entry.
      if (isOwnEditEcho) pendingEditsRef.current = pendingEdits.slice(echoed + 1);
      lastSyncedEditsRef.current = incomingEdits;
      // The background has answered for the step, rather than merely written to the tab's key, so
      // the optimistic status has served its purpose — stand it down here, where the update actually
      // arrives. See {@link answersTheCommand} for why this is the test and the simpler ones are not.
      if (answersTheCommand(progressMoved, pageStateMoved, isOwnEditEcho)) {
        setPending(null);
        // Any persisted progress supersedes a panel-local delivery error from the command that
        // requested it. Usually an undelivered command produces no storage event at all; this covers
        // the narrower race where Chrome reports an error as a worker is coming back.
        setDispatch(null);
      }
    });
  }, [scopeToken, tabId]);

  const edit = useCallback(
    (
      edits: Pick<PipelineRunState, 'answers' | 'jobDescription'> & {
        tailoredResume?: TailoredResume;
        status?: 'filled';
      },
    ) => {
      if (tabId === null || !run) return;

      // Apply locally first so a controlled textarea doesn't lag a storage round-trip.
      const merged = { ...run, ...edits };
      setRun(merged);

      // `panelEditsOf(merged)` — not `edits` directly — so this always carries the same shape an
      // incoming echo's `panelEditsOf(incoming)` will, tailoredResume included even when this
      // particular call didn't touch it. Serializing `edits` as sent would drop tailoredResume from
      // that comparison whenever an answers-only edit omitted it, and the echo for the *next* resume
      // edit would then never be recognized as this hook's own — leaving it "pending" forever.
      const serialized = JSON.stringify(panelEditsOf(merged));
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

  // Unsticks a run whose worker died. A step reports progress by writing to the store, so a panel
  // watching one that stopped has nothing to time out against and nothing that will ever arrive:
  // Chrome stopped the worker, the checkpoint still says `analyzing`, and the sweep that would
  // demote it only runs when a worker *starts*. An open panel starts none.
  //
  // So while a step claims to be running, ask. If the worker is alive the message is a no-op and
  // the step continues; if it is gone, the message starts one, whose first act is the repair — and
  // the resulting store write reaches this hook through the subscription above, like any other
  // progress. `lib/keepAlive.ts` makes the death far less likely; this is what makes it survivable.
  useEffect(() => {
    if (tabId === null) return;
    if (!isBusy(storedStatus)) return;

    const interval = setInterval(() => notify({ type: 'CHECK_RUN', tabId }), RUN_CHECK_MS);
    return () => clearInterval(interval);
  }, [storedStatus, tabId]);

  const beginCommand = useCallback((step: RunStep) => {
    const attempt = ++attemptRef.current;
    setDispatch(null);
    setPending(STEP_STATUS[step].running);

    return (_message: string) => {
      // Whatever this attempt has been superseded by owns the panel now. A late delivery error from
      // a command the user has already replaced would otherwise stand the newer one's status down.
      if (attempt !== attemptRef.current) return;
      setPending(null);
      setDispatch({ status: STEP_STATUS[step].failed, failure: { step, kind: 'temporary' } });
    };
  }, []);

  // Effects reset the state after a scope change; hide it during that render as well.
  const scopeIsCurrent = scopeTokenRef.current === scopeToken;
  const storedRun = scopeIsCurrent ? run : null;
  const visibleRun = storedRun && accepts(storedRun) ? storedRun : null;
  return {
    run: visibleRun,
    status: scopeIsCurrent ? (dispatch?.status ?? pending ?? visibleRun?.status ?? null) : null,
    failure: scopeIsCurrent ? (dispatch?.failure ?? visibleRun?.failure ?? null) : null,
    beginCommand,
    edit,
  };
}
