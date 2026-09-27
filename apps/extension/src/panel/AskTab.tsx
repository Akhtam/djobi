/**
 * The "Ask" tab: one conversation about one application question. Cold asks and refinements of a
 * drafted answer are the same component and route, differing only by {@link AskSeed}: with a seed,
 * "Use this answer" writes back to the run's answer; without one, there's a copy button. Never
 * writes to the page.
 *
 * The question is typed into the same composer as every turn, but sent as the request's `question`
 * (see `Turn.opening`). The thread is React-local and lost when the panel closes; an answer applied
 * to the run survives.
 *
 * The conversation logic is `panel/useAskThread.ts`; this is the transcript, composer, scroll and
 * clipboard.
 */
import type { JobInfo, Profile } from '@djobi/shared';
import { useEffect, useRef, useState } from 'react';
import type { BackendClient } from '../lib/backendClient';
import { useAskThread, type AskSeed, type Turn } from './useAskThread';

export type { AskSeed } from './useAskThread';

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
  /**
   * Writes an answer back onto the run's question card (still editable there). `runId` travels with
   * it, so a write-back racing a tab switch can't land on another run.
   */
  onUseAnswer: (runId: string, fieldId: string, answer: string) => void;
}) {
  const thread = useAskThread(client, profile, jobInfo, seed);
  const { subject, turns, pending, error } = thread;
  const [draft, setDraft] = useState('');
  // Which *turn's* answer was copied. Keyed by the answer's text, two turns that produced the same
  // answer both read "Copied".
  const [copiedTurnId, setCopiedTurnId] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  const refining = subject?.refining ?? null;
  const conversing = subject !== null;
  const canUseAnswer = refining !== null && refining.runId === activeRunId;

  // The composer belongs to the surface, so clearing it does too — a new hand-off is a new thread.
  useEffect(() => {
    if (!seed) return;
    setDraft('');
    setCopiedTurnId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the token is the hand-off signal
  }, [seed?.token]);

  // Follows the newest turn, the way a chat transcript is expected to. `scrollIntoView` is absent
  // in jsdom, so this is called defensively rather than guarded by a test-only branch.
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView?.({ block: 'end' });
  }, [turns.length, pending, error]);

  // Auto-grow the composer between the `App.css` floor and cap. `scrollHeight` excludes the border
  // on a `border-box` element, so add it back.
  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = 'auto';
    const border = composer.offsetHeight - composer.clientHeight;
    composer.style.height = `${composer.scrollHeight + border}px`;
  }, [draft]);

  function startOver() {
    thread.startOver();
    setDraft('');
    setCopiedTurnId(null);
  }

  /**
   * Sends what's in the composer — the question on the first turn of a cold ask, a message after.
   */
  function submit() {
    const text = draft.trim();
    if (!text || pending) return;
    thread.ask(text);
    setDraft('');
  }

  function copyAnswer(turn: Turn) {
    if (!turn.revisedAnswer) return;
    void navigator.clipboard?.writeText(turn.revisedAnswer).then(
      () => setCopiedTurnId(turn.id),
      () => setCopiedTurnId(null),
    );
  }

  return (
    <div className="ask">
      {conversing && (
        <div className="ask-subject">
          <div className="ask-subject-text">
            <span className="eyebrow">{refining ? 'Refining an answer' : 'Question'}</span>
            <p>{subject.question}</p>
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
              Ask about a question djobi didn't find on the page, or one from a form somewhere else.
            </p>
            <p className="hint">
              Answers come from your profile{jobInfo ? ' and this job posting' : ''}. Nothing here
              is written to the page.
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

        {turns.map((turn) => (
          <div className={`ask-msg ${turn.role}`} key={turn.id}>
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
                        onClick={() =>
                          onUseAnswer(refining.runId, refining.fieldId, turn.revisedAnswer!)
                        }
                      >
                        Use this answer
                      </button>
                    ) : null}
                    <button type="button" className="btn-link" onClick={() => copyAnswer(turn)}>
                      {copiedTurnId === turn.id ? 'Copied' : 'Copy answer'}
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
              onClick={thread.retry}
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
