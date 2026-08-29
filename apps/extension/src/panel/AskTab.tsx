/**
 * The "Ask" tab: one conversation about one application question.
 *
 * It is the panel's only chat surface, and deliberately so. Asking cold — a question the detector
 * missed, or one from a form on another screen entirely — and refining an answer the Analysis Step
 * already drafted are the same conversation with a different starting state, so they are the same
 * component talking to the same route. Building them apart would have put two chat implementations
 * in one panel.
 *
 * What separates the two here is the {@link AskSeed}. With one, the thread is *about* a specific
 * drafted answer in the current run, and "Use this answer" writes back to it. Without one, there is
 * no field to write to, so the answer gets a copy button instead. This tab never writes to the
 * page: filling stays the Fill Step's job, from detected fields.
 *
 * The layout is a transcript with one composer pinned under it, rather than a form whose fields
 * grow as the exchange goes on. That is why the *question* is typed into the composer too: a cold
 * ask's first message is the question, so there is one place to type on every turn instead of a
 * question box that stops mattering after the first send. It is sent as the request's `question`
 * rather than as a thread message — hence {@link Turn.opening}, which marks the one turn the
 * transcript shows but the wire doesn't carry.
 *
 * The thread is React-local and lost when the panel closes. A cold ask has no run to hang off, and
 * `PipelineRunState` is keyed by tab — the wrong shape for a conversation that may be about no page
 * at all. A seeded thread plausibly belongs there, but persisting only half the tab's threads would
 * make "will this still be here later" depend on where the thread started, which is worse than a
 * rule the candidate can hold: the answer applied to the run survives, the conversation doesn't.
 */
import type { ChatMessage, JobInfo, Profile } from '@djobi/shared';
import { useEffect, useRef, useState } from 'react';
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
interface Turn extends ChatMessage {
  revisedAnswer?: string;
  /**
   * A turn the transcript shows but the request's `messages` must not carry: the question itself,
   * on a cold ask. It travels as the `question` field, and sending it twice would show the model
   * its own scaffold back as something the candidate said.
   */
  opening?: true;
}

/** What went wrong, for the inline error line — a `BackendError` names the path and status. */
function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

export function AskTab({
  client,
  profile,
  jobInfo,
  activeRunId,
  seed,
  onUseAnswer,
}: {
  /** The backend seam, handed down by the shell — see `panel/App.tsx`. */
  client: BackendClient;
  profile: Profile;
  /** The run's job, when there is a run. Absent is normal: this tab works with no job page. */
  jobInfo: JobInfo | null;
  /** The run currently visible in Autofill, or null when the active tab has none. */
  activeRunId: string | null;
  seed: AskSeed | null;
  /** Writes an answer back onto the run's question card. Still hand-editable there afterward. */
  onUseAnswer: (fieldId: string, answer: string) => void;
}) {
  /** The question under discussion, fixed once the conversation has one. '' until then. */
  const [question, setQuestion] = useState('');
  /** The seeded draft and the field it came from, or null for a cold ask. */
  const [refining, setRefining] = useState<{
    runId: string;
    fieldId: string;
    currentAnswer: string;
    jobInfo: JobInfo | null;
  } | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which answer was copied, not just that one was — otherwise every turn's button reads "Copied".
  const [copiedAnswer, setCopiedAnswer] = useState<string | null>(null);
  // Answers a turn that has already been superseded — by a reset, or by starting over — must not
  // land in the thread they were not asked in.
  const turnRequestRef = useRef(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  const conversing = question !== '' || refining !== null;
  const canUseAnswer = refining !== null && refining.runId === activeRunId;

  /**
   * Takes a hand-off from a question card. Keyed by the seed's token rather than its contents, so
   * refining the same card again — same question, same draft — still starts a fresh thread instead
   * of silently continuing the old one.
   */
  useEffect(() => {
    if (!seed) return;
    ++turnRequestRef.current;
    setQuestion(seed.question);
    setRefining({
      runId: seed.runId,
      fieldId: seed.fieldId,
      currentAnswer: seed.currentAnswer,
      jobInfo,
    });
    setTurns([]);
    setDraft('');
    setPending(false);
    setError(null);
    setCopiedAnswer(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the token is the hand-off signal
  }, [seed?.token]);

  // Follows the newest turn, the way a chat transcript is expected to. `scrollIntoView` is absent
  // in jsdom, so this is called defensively rather than guarded by a test-only branch.
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView?.({ block: 'end' });
  }, [turns.length, pending, error]);

  // The composer grows with what's typed into it, between the floor and cap in `App.css`.
  // `scrollHeight` excludes the border, and the box is `border-box`, so the border is added back —
  // without it the field ends up two pixels short of its own content and scrolls by one line.
  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = 'auto';
    const border = composer.offsetHeight - composer.clientHeight;
    composer.style.height = `${composer.scrollHeight + border}px`;
  }, [draft]);

  function startOver() {
    ++turnRequestRef.current;
    setQuestion('');
    setRefining(null);
    setTurns([]);
    setDraft('');
    setPending(false);
    setError(null);
    setCopiedAnswer(null);
  }

  /**
   * Sends one turn.
   *
   * `nextTurns` is the transcript as it will read while the request is in flight — the candidate's
   * new message is already in it. Retrying after a failure passes the transcript unchanged, which
   * is exactly what the route wants: it already ends with the turn that went unanswered.
   */
  async function send(askedQuestion: string, nextTurns: Turn[]) {
    const requestToken = ++turnRequestRef.current;
    setTurns(nextTurns);
    setDraft('');
    setError(null);
    setPending(true);
    try {
      const { reply, revisedAnswer } = await client.answerChat({
        profile,
        question: askedQuestion,
        jobInfo: refining?.jobInfo ?? jobInfo,
        currentAnswer: refining?.currentAnswer,
        // Only the two fields the wire contract carries, and only the turns it should carry: the
        // opening question travels as `question`, and a turn's answer is display state here.
        messages: nextTurns
          .filter((turn) => !turn.opening)
          .map(({ role, content }) => ({ role, content })),
      });
      if (requestToken !== turnRequestRef.current) return;
      setTurns([...nextTurns, { role: 'assistant', content: reply, revisedAnswer }]);
    } catch (failure) {
      if (requestToken !== turnRequestRef.current) return;
      // The candidate's turn stays in the transcript: it is what Retry re-sends.
      setError(failureMessage(failure));
    } finally {
      if (requestToken === turnRequestRef.current) setPending(false);
    }
  }

  /** Sends what's in the composer — the question on the first turn of a cold ask, a message after. */
  function submit() {
    const text = draft.trim();
    if (!text || pending) return;

    if (!question) {
      // The question is passed explicitly: this state update won't have landed by the time the
      // request is built.
      setQuestion(text);
      void send(text, [{ role: 'user', content: text, opening: true }]);
      return;
    }
    void send(question, [...turns, { role: 'user', content: text }]);
  }

  function copyAnswer(answer: string) {
    void navigator.clipboard?.writeText(answer).then(
      () => setCopiedAnswer(answer),
      () => setCopiedAnswer(null),
    );
  }

  return (
    <div className="ask">
      {conversing && (
        <div className="ask-subject">
          <div className="ask-subject-text">
            <span className="eyebrow">{refining ? 'Refining an answer' : 'Question'}</span>
            <p>{question}</p>
          </div>
          <button type="button" className="btn-link" onClick={startOver} disabled={pending}>
            New question
          </button>
        </div>
      )}

      <div className="ask-transcript">
        {!conversing && (
          <div className="ask-intro">
            <span className="state-icon">💬</span>
            <p>
              Ask about a question djobi didn't find on the page — or one from a form somewhere
              else.
            </p>
            <p className="hint">
              Answers are grounded in your profile{jobInfo ? ' and this job posting' : ''}, and
              nothing here is written to the page.
            </p>
          </div>
        )}

        {refining && (
          <div className="ask-context">
            <span className="eyebrow">Current answer</span>
            <p>{refining.currentAnswer}</p>
          </div>
        )}

        {refining && !canUseAnswer && (
          <p className="inline-warning" role="status">
            Switch back to the application this answer came from to apply it.
          </p>
        )}

        {turns.map((turn, index) => (
          <div className={`ask-msg ${turn.role}`} key={index}>
            <span className="ask-msg-role">{turn.role === 'user' ? 'You' : 'djobi'}</span>
            <div className="ask-msg-body">
              <p>{turn.content}</p>
              {turn.revisedAnswer && (
                <div className="ask-answer">
                  <span className="eyebrow">Answer</span>
                  <p>{turn.revisedAnswer}</p>
                  <div className="ask-answer-actions">
                    {canUseAnswer ? (
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => onUseAnswer(refining.fieldId, turn.revisedAnswer!)}
                      >
                        Use this answer
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn-link"
                      onClick={() => copyAnswer(turn.revisedAnswer!)}
                    >
                      {copiedAnswer === turn.revisedAnswer ? 'Copied' : 'Copy answer'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}

        {pending && (
          <div className="ask-msg assistant" role="status" aria-live="polite">
            <span className="ask-msg-role">djobi</span>
            <div className="ask-msg-body">
              <span className="ask-typing" aria-label="Writing…">
                <i />
                <i />
                <i />
              </span>
            </div>
          </div>
        )}

        {error && (
          <div className="inline-error" role="alert">
            <div className="inline-error-body">
              <p>Something went wrong asking about this question.</p>
              <p className="failure-detail">{error}</p>
            </div>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void send(question, turns)}
              disabled={pending}
            >
              Try again
            </button>
          </div>
        )}

        <div ref={transcriptEndRef} />
      </div>

      <form
        className="ask-composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="sr-only" htmlFor="ask-composer">
          {conversing ? 'Message' : 'Application question'}
        </label>
        <textarea
          id="ask-composer"
          ref={composerRef}
          rows={1}
          placeholder={
            conversing
              ? refining && turns.length === 0
                ? 'What should change?'
                : 'Ask for a change, or for something else…'
              : 'Paste the question you need an answer to…'
          }
          value={draft}
          disabled={pending}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks the line — what every chat composer does, and the
            // reason this is a textarea rather than an input.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="submit"
          className="ask-send"
          aria-label="Send"
          disabled={pending || !draft.trim()}
        >
          {/* An SVG rather than an arrow glyph: a character is positioned by the font's baseline
              and sits visibly off-centre in a round button, differently in every font stack. */}
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </form>
    </div>
  );
}
