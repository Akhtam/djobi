/**
 * The panel shell, mounted by `panel/main.tsx` as the side panel's sole content (see `manifest.ts`'s
 * `side_panel.default_path` — there's no popup).
 *
 * It owns three things and no flow: the Profile bootstrap every tab needs before it can do
 * anything, the tab switch, and the hand-off from a question card to the Ask Tab. Each flow is its
 * own module — `AutofillTab`, `LogApplication`, `AskTab` — so adding a fourth costs a module and a
 * button rather than another meaning threaded through this one.
 *
 * The run itself is not the shell's either: `useActiveRun` owns it, because two tabs read it (the
 * Autofill Tab renders it; the Ask Tab grounds answers in its Job Info and writes one back) and one
 * copy of a run in the panel is the point. What the shell does with it is one thing — the header
 * pill.
 *
 * `client` is a prop rather than something this module constructs, so a test drives the whole panel
 * through a fake adapter with no network — `panel/main.tsx` is the only place the real one is
 * named. The Application Pipeline has always taken its backend this way (`PipelineDeps`); this is
 * the panel half of the same seam.
 *
 * The panel survives switching tabs, unlike a popup, which is destroyed on any outside click. It
 * re-tracks the active tab rather than remounting; `useActiveRun` is where that is handled.
 */
import type { Profile } from '@djobi/shared';
import { useEffect, useRef, useState } from 'react';
import './App.css';
import icon48 from '../assets/icons/icon48.png';
import type { BackendClient } from '../lib/backendClient';
import { isUnauthorized, userMessage } from '../lib/callBackend';
import { ThemeToggle, useThemePreference } from '../lib/theme';
import { AskTab, type AskSeed } from './AskTab';
import { AutofillTab } from './AutofillTab';
import { LogApplication } from './LogApplication';
import { useActiveRun } from './useActiveRun';

/** Where the Profile bootstrap has got to. Everything past it belongs to a tab, not to the shell. */
type BootstrapStatus = 'loading' | 'unauthorized' | 'profile-error' | 'no-profile' | 'ready';

/**
 * What `loadProfile`'s catch branch learned about a failed `getProfile` — same split
 * `options/App.tsx`'s own bootstrap makes, and for the same reason: a 401 that survived
 * `withSessionRecovery`'s own adopt-and-retry is "go sign in somewhere," not "the backend is
 * broken," and the two need different copy and a different fix, not one generic banner that always
 * points at the backend regardless of which one actually happened.
 */
type ProfileLoadError = { kind: 'unauthorized' } | { kind: 'other'; message: string };

/**
 * Which of the panel's flows is showing. Tabs rather than modes on one flow: neither Log nor Ask
 * shares state with the Application Pipeline — no detected form, no `PipelineStatus` — so folding
 * either in would mean threading a second meaning through every branch of `reviewOf`.
 *
 * Ask is reachable at any point in a run, including before there is one, since a question needs no
 * run to be worth answering. What it *can* do grows with the run: a question card hands it a seed,
 * and with one it can write an answer back.
 */
type PanelTab = 'autofill' | 'log' | 'ask';

export function App({ client }: { client: BackendClient }) {
  const { theme, toggleTheme } = useThemePreference();
  const [tab, setTab] = useState<PanelTab>('autofill');
  // The hand-off from a question card to the Ask tab. `token` is what makes a second hand-off from
  // the same card a new thread rather than a no-op — the question and draft may be unchanged.
  const [askSeed, setAskSeed] = useState<AskSeed | null>(null);
  const askSeedTokenRef = useRef(0);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [profileError, setProfileError] = useState<ProfileLoadError | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const profileRequestRef = useRef(0);

  // The tracked page and its run. Not started until there's a Profile to act with.
  const activeRun = useActiveRun(Boolean(profile));

  const bootstrap: BootstrapStatus = !profileLoaded
    ? 'loading'
    : profileError?.kind === 'unauthorized'
      ? 'unauthorized'
      : profileError
        ? 'profile-error'
        : !profile
          ? 'no-profile'
          : 'ready';

  function loadProfile() {
    const requestToken = ++profileRequestRef.current;
    setProfileLoaded(false);
    setProfileError(null);

    void (async () => {
      try {
        // Session recovery — adopting a shared dashboard session and retrying once on a 401 — is
        // `client`'s own concern now (`backendClient.ts`'s `withSessionRecovery`), not just this
        // bootstrap call's. Every route gets the same one shot at recovery before a 401 means
        // there really is nothing to sign in with.
        const loadedProfile = await client.getProfile();
        if (requestToken !== profileRequestRef.current) return;
        setProfile(loadedProfile);
        setProfileLoaded(true);
      } catch (error: unknown) {
        if (requestToken !== profileRequestRef.current) return;
        setProfileError(
          isUnauthorized(error)
            ? { kind: 'unauthorized' }
            : { kind: 'other', message: userMessage(error) },
        );
        setProfileLoaded(true);
      }
    })();
  }

  /*
    Reruns `loadProfile()` rather than setting some dedicated "signed out" state: its 401 branch
    already exists (`profileError`, pointing at "Open profile settings" — the one surface with a
    real Login gate), so ending the session here needs no new state, just the same path a session
    that merely expired already takes.
  */
  function handleSignOut() {
    void client.signOut().then(loadProfile);
  }

  useEffect(() => {
    loadProfile();
    return () => {
      ++profileRequestRef.current;
    };
    // Profile bootstrap runs once; retries are explicit user actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Hands one drafted answer to the Ask Tab and switches to it. Which answers may be handed over is
   * the Autofill Tab's call — it is the module that knows which Detected Field each answer came
   * from, and only a freeform one can take a rewritten answer back.
   */
  function refineAnswer(fieldId: string, question: string, currentAnswer: string) {
    const runId = activeRun.run?.runId;
    if (!runId) return;
    setAskSeed({ runId, fieldId, question, currentAnswer, token: ++askSeedTokenRef.current });
    setTab('ask');
  }

  // The pill describes the Application Pipeline run, so it is suppressed on every other tab —
  // there is no run there for it to be about — and while the panel is still booting, so a hydrated
  // run doesn't flash its pill before we know there's a Profile to act with.
  const pill = bootstrap === 'ready' && tab === 'autofill' ? activeRun.review.pill : null;

  return (
    <main className="panel">
      <header className="panel-header">
        <img src={icon48} alt="" className="brand-mark" />
        <h1>djobi</h1>
        {pill && (
          <span className={`status-pill ${pill.tone}`} role="status" aria-live="polite">
            {pill.label}
          </span>
        )}
        <div className="header-actions">
          {profile && (
            <button type="button" className="btn-secondary" onClick={handleSignOut}>
              Sign out
            </button>
          )}
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      {bootstrap === 'loading' && (
        <div className="panel-body">
          <div className="state" role="status" aria-live="polite">
            <span className="spinner" />
            <p>Loading…</p>
          </div>
        </div>
      )}

      {/*
        Distinct from `profile-error` below: a 401 that survived `withSessionRecovery`'s own
        adopt-and-retry means there really is nothing to sign in with here — not this browser's
        dashboard session (there may be none open, or its cookie may not be reachable from this
        extension — see `sharedSessionCookie.ts`) and not a token of the extension's own. That's
        "go sign in," never "the backend is unreachable," so it gets its own copy and its own
        primary action rather than sharing profile-error's backend-focused one. The options page is
        where sign-in actually lives (`options/App.tsx`'s own `Login`) — the panel has no sign-in
        form of its own to render here.
      */}
      {bootstrap === 'unauthorized' && (
        <div className="panel-body">
          <div className="state error" role="alert">
            <span className="state-icon error">🔒</span>
            <p>You're not signed in. Sign in from profile settings to load your profile here.</p>
            <button
              type="button"
              className="btn-primary"
              onClick={() => chrome.runtime.openOptionsPage()}
            >
              Open profile settings
            </button>
            <button type="button" className="btn-secondary" onClick={loadProfile}>
              Retry loading profile
            </button>
          </div>
        </div>
      )}

      {bootstrap === 'profile-error' && (
        <div className="panel-body">
          <div className="state error" role="alert">
            <span className="state-icon error">⚠️</span>
            <p>
              Couldn't load your profile
              {profileError?.kind === 'other' ? `: ${profileError.message}` : '.'}
            </p>
            <button type="button" className="btn-primary" onClick={loadProfile}>
              Retry loading profile
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => chrome.runtime.openOptionsPage()}
            >
              Open profile settings
            </button>
          </div>
        </div>
      )}

      {bootstrap === 'no-profile' && (
        <div className="panel-body">
          <div className="state" role="status">
            <span className="state-icon">👤</span>
            <p>Set up your profile and you're ready to go.</p>
            <button
              type="button"
              className="btn-primary"
              onClick={() => chrome.runtime.openOptionsPage()}
            >
              Open profile settings
            </button>
          </div>
        </div>
      )}

      {profile && (
        <>
          <nav className="panel-tabs" aria-label="Panel sections">
            <button
              type="button"
              className={tab === 'autofill' ? 'panel-tab active' : 'panel-tab'}
              aria-current={tab === 'autofill'}
              onClick={() => setTab('autofill')}
            >
              Autofill
            </button>
            <button
              type="button"
              className={tab === 'log' ? 'panel-tab active' : 'panel-tab'}
              aria-current={tab === 'log'}
              onClick={() => setTab('log')}
            >
              Log
            </button>
            <button
              type="button"
              className={tab === 'ask' ? 'panel-tab active' : 'panel-tab'}
              aria-current={tab === 'ask'}
              onClick={() => setTab('ask')}
            >
              Ask
            </button>
          </nav>

          {/*
            Every pane stays mounted and is hidden rather than unmounted. Extracting a posting on the
            Log tab is a model call, and an Ask thread is a conversation; switching to Autofill to
            glance at the run used to throw either away — the panel's promise is that nothing in
            flight is lost by looking somewhere else.
          */}
          <div className="panel-body" hidden={tab !== 'log'}>
            <LogApplication client={client} profile={profile} activeTabUrl={activeRun.tabUrl} />
          </div>

          <div className="panel-body ask-pane" hidden={tab !== 'ask'}>
            <AskTab
              client={client}
              profile={profile}
              jobInfo={activeRun.run?.jobInfo ?? null}
              activeRunId={activeRun.run?.runId ?? null}
              seed={askSeed}
              onUseAnswer={activeRun.updateAnswer}
            />
          </div>

          <AutofillTab
            client={client}
            profile={profile}
            activeRun={activeRun}
            onRefineAnswer={refineAnswer}
            hidden={tab !== 'autofill'}
          />
        </>
      )}
    </main>
  );
}
