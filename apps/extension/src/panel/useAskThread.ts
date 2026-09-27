/**
 * One Ask Tab conversation: the thread and the rules for sending a turn.
 *
 * - **The job is snapshotted when a conversation starts**, so switching browser tabs doesn't
 *   re-ground later turns in another posting.
 * - **A turn's answer carries its run**, so "Use this answer" can't land on the wrong run.
 * - **Turns have ids**, so identical answers don't share copy state.
 */
import { userMessage } from '@djobi/http-client';
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
  /** Stable for the life of the turn; the transcript's key and the copy state's key. */
  id: string;
  revisedAnswer?: string | undefined;
  /**
   * Shown in the transcript but not sent in `messages`: a cold ask's question, which travels as the
   * `question` field.
   */
  opening?: true;
}

/** What the thread is about, fixed for as long as the conversation lives. */
interface Subject {
  question: string;
  /** The job when this conversation started, or `null` — captured once, not read per turn. */
  jobInfo: JobInfo | null;
  /**
   * The draft and the field it came from, when a question card seeded this. `null` for a cold ask.
   */
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
   * Re-sends the failed turn unchanged (re-asking would duplicate the candidate's message).
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
 * @param jobInfo - The run's job, read only when a conversation starts. Absent is normal.
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
   * Takes a hand-off from a question card, keyed by the seed's token so refining the same card
   * again starts a fresh thread.
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
   * Sends one turn. `nextTurns` is the transcript while in flight (the new message included); a
   * retry passes it unchanged.
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
        setError(userMessage(failure));
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

      // A cold ask's first message is the question: fix the subject and job here, passed explicitly
      // since state won't have updated yet.
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
