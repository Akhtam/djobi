/**
 * One Ask Tab conversation: the thread, and every rule about how a turn is sent.
 *
 * Split out of `panel/AskTab.tsx`, which held both this and the transcript that renders it. The
 * rules here are not presentational and several of them are subtle — which turn is the scaffold's
 * and must not be re-sent, which answers belong to a thread that has since been replaced, what
 * projection of a turn crosses the wire — and while they lived beside the JSX the only way to reach
 * any of them was to render a component and type into it. The tab keeps what is genuinely the
 * tab's: scrolling, the growing composer, the clipboard, and the words.
 *
 * The seam also settled three things that were wrong and had nowhere to be noticed:
 *
 * - **The job is snapshotted when a conversation starts, whichever way it started.** A seeded thread
 *   captured its `jobInfo`; a cold one read the live prop on every turn, so switching browser tabs
 *   mid-conversation silently re-grounded the next answer in a different posting.
 * - **A turn's answer carries the run it belongs to.** "Use this answer" checked the run at render
 *   and then handed back a bare `fieldId`, so a write-back racing a tab switch could land on the
 *   wrong run's question card. The run travels with the answer instead.
 * - **Turns have identity.** Copy state was keyed by the answer's *text*, so two turns that produced
 *   the same answer both read "Copied".
 */
import { failureMessage } from '@djobi/shared';
import type { ChatMessage, JobInfo, Profile } from '@djobi/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackendClient } from '../lib/backendClient';

/** A question card handing this tab the answer it wants rewritten. */
export interface AskSeed {
  /** The run this field belongs to, so a tab switch cannot redirect the write-back. */
  runId: string;
  /** The run answer "Use this answer" writes back to. */
  fieldId: string;
  question: string;
  currentAnswer: string;
  /** Bumped by every hand-off, so refining the same card twice starts a fresh thread. */
  token: number;
}

/** One turn as the transcript shows it — the assistant's carries the answer that turn produced. */
export interface Turn extends ChatMessage {
  /**
   * Stable for the life of the turn, and the transcript's key.
   *
   * The index was the key and the answer text was the copy state's key, which made both wrong in
   * the same way: two turns that produce the same answer are still two turns.
   */
  id: string;
  revisedAnswer?: string;
  /**
   * A turn the transcript shows but the request's `messages` must not carry: the question itself,
   * on a cold ask. It travels as the `question` field, and sending it twice would show the model
   * its own scaffold back as something the candidate said.
   */
  opening?: true;
}

/** What the thread is about, fixed for as long as the conversation lives. */
interface Subject {
  question: string;
  /**
   * The job as it stood when this conversation started, or `null` when there was no run.
   *
   * Captured rather than read per turn. The panel's `jobInfo` follows the browser tab, and a
   * conversation whose grounding changes underneath it answers the second turn about a different
   * posting than the first.
   */
  jobInfo: JobInfo | null;
  /** The draft and the field it came from, when a question card seeded this. `null` for a cold ask. */
  refining: { runId: string; fieldId: string; currentAnswer: string } | null;
}

export interface AskThread {
  /** What the conversation is about, or `null` before there is one. */
  subject: Subject | null;
  turns: Turn[];
  /** A turn is in flight. */
  pending: boolean;
  /** The last turn's failure, cleared by the next attempt. */
  error: string | null;
  /** Sends `text`: the question on a cold ask's first turn, a message on every turn after it. */
  ask: (text: string) => void;
  /**
   * Re-sends the turn that failed, unchanged.
   *
   * First-class rather than "ask the same thing again": the transcript already ends with the turn
   * that went unanswered, which is exactly what the route wants, and re-`ask`ing would append the
   * candidate's message a second time.
   */
  retry: () => void;
  /** Abandons the conversation and returns the tab to its empty state. */
  startOver: () => void;
}

let nextTurnId = 0;
function turnId(): string {
  return `turn-${++nextTurnId}`;
}

/**
 * @param jobInfo - The run's job, read only when a conversation *starts*. Absent is normal: this
 *   tab works with no job page at all.
 * @param seed - A hand-off from a question card, or `null`.
 */
export function useAskThread(
  client: BackendClient,
  profile: Profile,
  jobInfo: JobInfo | null,
  seed: AskSeed | null,
): AskThread {
  const [subject, setSubject] = useState<Subject | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Answers a turn that has already been superseded — by a reset, or by starting over — must not
  // land in the thread they were not asked in.
  const turnRequestRef = useRef(0);
  // The live job, for the one moment a cold conversation starts. A ref rather than a dependency:
  // reading it during `ask` is what keeps a started conversation's grounding fixed.
  const jobInfoRef = useRef(jobInfo);
  jobInfoRef.current = jobInfo;

  /**
   * Takes a hand-off from a question card. Keyed by the seed's token rather than its contents, so
   * refining the same card again — same question, same draft — still starts a fresh thread instead
   * of silently continuing the old one.
   */
  useEffect(() => {
    if (!seed) return;
    ++turnRequestRef.current;
    setSubject({
      question: seed.question,
      jobInfo: jobInfoRef.current,
      refining: { runId: seed.runId, fieldId: seed.fieldId, currentAnswer: seed.currentAnswer },
    });
    setTurns([]);
    setPending(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the token is the hand-off signal
  }, [seed?.token]);

  const startOver = useCallback(() => {
    ++turnRequestRef.current;
    setSubject(null);
    setTurns([]);
    setPending(false);
    setError(null);
  }, []);

  /**
   * Sends one turn.
   *
   * `nextTurns` is the transcript as it will read while the request is in flight — the candidate's
   * new message is already in it. Retrying passes the transcript unchanged, which is exactly what
   * the route wants: it already ends with the turn that went unanswered.
   */
  const send = useCallback(
    async (about: Subject, nextTurns: Turn[]) => {
      const requestToken = ++turnRequestRef.current;
      setTurns(nextTurns);
      setError(null);
      setPending(true);
      try {
        const { reply, revisedAnswer } = await client.answerChat({
          profile,
          question: about.question,
          jobInfo: about.jobInfo,
          currentAnswer: about.refining?.currentAnswer,
          // Only the two fields the wire contract carries, and only the turns it should carry: the
          // opening question travels as `question`, and a turn's answer is display state here.
          messages: nextTurns
            .filter((turn) => !turn.opening)
            .map(({ role, content }) => ({ role, content })),
        });
        if (requestToken !== turnRequestRef.current) return;
        setTurns([
          ...nextTurns,
          { id: turnId(), role: 'assistant', content: reply, revisedAnswer },
        ]);
      } catch (failure) {
        if (requestToken !== turnRequestRef.current) return;
        // The candidate's turn stays in the transcript: it is what Retry re-sends.
        setError(failureMessage(failure));
      } finally {
        if (requestToken === turnRequestRef.current) setPending(false);
      }
    },
    [client, profile],
  );

  const ask = useCallback(
    (text: string) => {
      if (!text || pending) return;

      if (subject) {
        void send(subject, [...turns, { id: turnId(), role: 'user', content: text }]);
        return;
      }

      // A cold ask's first message *is* the question, so this is where the conversation's subject —
      // including the job it is grounded in — is fixed. Passed explicitly rather than read back from
      // state, which will not have landed by the time the request is built.
      const started: Subject = { question: text, jobInfo: jobInfoRef.current, refining: null };
      setSubject(started);
      void send(started, [{ id: turnId(), role: 'user', content: text, opening: true }]);
    },
    [pending, send, subject, turns],
  );

  const retry = useCallback(() => {
    if (!subject || pending) return;
    void send(subject, turns);
  }, [pending, send, subject, turns]);

  return { subject, turns, pending, error, ask, retry, startOver };
}
