import type { TailoredResume } from '@djobi/shared';
import {
  type PipelineFailure,
  type PipelineRunState,
  type PipelineStatus,
  type RunStep,
  panelEditsOf,
  STEP_STATUS,
} from '../lib/run';
import { updateRun, type UpdateRunMessage, type UpdateRunOutcome } from '../lib/messages';
import {
  getPipelineRun,
  subscribePipelineRun,
  type PipelineRunChange,
} from '../lib/tabStore/pipelineRun';

export type RunEdits = Pick<PipelineRunState, 'answers' | 'jobDescription'> & {
  tailoredResume?: TailoredResume;
};

/**
 * What the view shows: `run` including this panel's optimistic edits; `status`/`failure` reconciled
 * (delivery failure, then optimistic status, then the stored run's).
 */
export interface RunViewSnapshot {
  run: PipelineRunState | null;
  /** The optimistic status this panel raised and the background has not yet answered. */
  pending: PipelineStatus | null;
  /** A command this panel sent that never reached the background, or whose claim was refused. */
  dispatch: {
    status: 'analyze-error' | 'fill-error' | 'save-error';
    failure: PipelineFailure;
  } | null;
}

/** Where a run view reads, hears about, and sends edits to one tab's run. */
export interface RunViewPorts {
  read: (tabId: number) => Promise<PipelineRunState | null>;
  subscribe: (tabId: number, onChange: (change: PipelineRunChange) => void) => () => void;
  updateRun: (message: UpdateRunMessage) => Promise<UpdateRunOutcome>;
}

export const chromeRunViewPorts: RunViewPorts = {
  read: getPipelineRun,
  subscribe: subscribePipelineRun,
  updateRun,
};

export interface RunView {
  snapshot: () => RunViewSnapshot;
  /** Notifies `onChange` after every snapshot change. */
  subscribe: (onChange: () => void) => () => void;
  /** Reads the stored run and follows the store until the returned `stop` is called. */
  start: () => () => void;
  /**
   * Raises `step`'s running status now and returns **that attempt's** callback to stand it down as
   * a delivery failure (undelivered or refused). A newer command makes the old callback a no-op.
   * The status stands down on a real background write (see {@link answersTheCommand}); raising one
   * clears any delivery failure.
   */
  beginCommand: (step: RunStep) => () => void;
  /**
   * Applies edits locally at once and sends them. If the store refuses (e.g. mid-save), the edit is
   * dropped and the run re-read; if nothing answered, it's kept and the next keystroke resends.
   */
  edit: (edits: RunEdits) => void;
}

const EMPTY: RunViewSnapshot = { run: null, pending: null, dispatch: null };

/**
 * One tab's run as the panel sees it: the stored run, this panel's edits, and its last command's
 * status, reconciled into one snapshot.
 *
 * The background owns every persisted mutation and all progress; this view owns only optimistic
 * edits and status, and never writes storage. Plain TypeScript so it's testable without React;
 * `usePipelineRun.ts` makes one per tab and scope.
 */
export function createRunView(tabId: number, ports: RunViewPorts = chromeRunViewPorts): RunView {
  let state = EMPTY;
  const listeners = new Set<() => void>();
  // Advances whenever a newer snapshot supersedes an in-flight read, or the view stops.
  let revision = 0;
  // Which command this panel most recently raised — see `beginCommand`.
  let attempt = 0;

  // The edits last persisted, serialized. Storage echoes every write back through `onChanged`,
  // including this view's own; without this the echo would be applied and written straight back
  // out.
  let lastSyncedEdits: string | null = null;
  // Sent-but-unechoed edits, oldest first — a queue, because two keystrokes within one round trip
  // would otherwise make the first echo look like a background write.
  let pendingEdits: string[] = [];

  function set(next: Partial<RunViewSnapshot>) {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  }

  /**
   * Takes `incoming`, but keeps this panel's edits while a later one is unanswered, so controlled
   * fields don't snap back.
   */
  function reconcile(incoming: PipelineRunState | null, keepLocal: boolean) {
    const local = state.run;
    if (incoming && keepLocal && local?.runId === incoming.runId) {
      return { ...incoming, ...panelEditsOf(local) };
    }
    return incoming;
  }

  function onStoreChange({ current: incoming, progressMoved, pageStateMoved }: PipelineRunChange) {
    ++revision;
    const incomingEdits = incoming ? JSON.stringify(panelEditsOf(incoming)) : null;
    // The oldest send this echo could be answering. Oldest rather than any, because an undo can
    // repeat an earlier value verbatim and the queue drains in the order it was filled.
    const echoed = incomingEdits === null ? -1 : pendingEdits.indexOf(incomingEdits);
    const isOwnEditEcho = echoed !== -1;
    // Only the *last* pending send leaves the store agreeing with what the user sees; an echo for
    // an earlier one is already stale by the time it lands.
    const caughtUp = echoed === pendingEdits.length - 1;
    const run = reconcile(incoming, pendingEdits.length > 0 && !caughtUp);
    // Drop everything up to and including the send this echo answers: those can never be matched
    // again, and leaving them would make a repeated value match an already-answered entry.
    if (isOwnEditEcho) pendingEdits = pendingEdits.slice(echoed + 1);
    lastSyncedEdits = incomingEdits;

    if (answersTheCommand(progressMoved, pageStateMoved, isOwnEditEcho)) {
      // Persisted progress also clears a delivery error (Chrome can report one as a worker
      // restarts).
      set({ run, pending: null, dispatch: null });
    } else {
      set({ run });
    }
  }

  function reread() {
    const readRevision = ++revision;
    void ports.read(tabId).then((stored) => {
      // A newer store event, or a stop, must not let this older snapshot replace live state.
      if (readRevision !== revision) return;
      lastSyncedEdits = stored ? JSON.stringify(panelEditsOf(stored)) : null;
      set({ run: reconcile(stored, pendingEdits.length > 0) });
    });
  }

  function dropPendingEdit(serialized: string) {
    // Remove only this entry: earlier accepted sends still have echoes in flight.
    const index = pendingEdits.indexOf(serialized);
    if (index !== -1)
      pendingEdits = [...pendingEdits.slice(0, index), ...pendingEdits.slice(index + 1)];
  }

  return {
    snapshot: () => state,

    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },

    start() {
      reread();
      const unsubscribe = ports.subscribe(tabId, onStoreChange);
      return () => {
        ++revision;
        unsubscribe();
      };
    },

    beginCommand(step) {
      const thisAttempt = ++attempt;
      set({ pending: STEP_STATUS[step].running, dispatch: null });

      return () => {
        if (thisAttempt !== attempt) return;
        set({
          pending: null,
          dispatch: { status: STEP_STATUS[step].failed, failure: { step, kind: 'temporary' } },
        });
      };
    },

    edit(edits) {
      const run = state.run;
      if (!run) return;

      const merged = { ...run, ...edits };
      set({ run: merged });

      // Serialized via `panelEditsOf(merged)` so it matches the shape of the incoming echo.
      const serialized = JSON.stringify(panelEditsOf(merged));
      if (serialized === lastSyncedEdits && pendingEdits.length === 0) return;
      pendingEdits = [...pendingEdits, serialized];

      void ports
        .updateRun({ type: 'UPDATE_RUN', tabId, runId: run.runId, updates: edits })
        .then(({ applied, delivered }) => {
          if (applied) return;
          // Nothing was written, so no echo is ever coming for this entry: left in the queue, every
          // later echo would keep losing the "keep local edits" race against it.
          dropPendingEdit(serialized);
          // Undelivered: keep the typing for the next keystroke to resend. Refused: re-read the
          // run.
          if (delivered) reread();
        });
    },
  };
}

/** A view for no tab: nothing stored, and nothing to send commands or edits for. */
export const NO_RUN_VIEW: RunView = {
  snapshot: () => EMPTY,
  subscribe: () => () => undefined,
  start: () => () => undefined,
  beginCommand: () => () => undefined,
  edit: () => undefined,
};

/**
 * Whether a store write is the background answering the optimistic command, so its status can stand
 * down. Uses the store's movement flags (from the event's own old/new values).
 *
 * Not "any write" (frame reports and Job Context share the key), not "the run changed" (edit echoes
 * change it), not "the status changed" (a re-fill goes `filled` → `filled`). Exempted positively:
 * page-scoped-only writes and this view's own echoes; anything else stands the optimism down.
 */
function answersTheCommand(
  progressMoved: boolean,
  pageStateMoved: boolean,
  isOwnEditEcho: boolean,
) {
  if (progressMoved) return true;
  return !pageStateMoved && !isOwnEditEcho;
}
