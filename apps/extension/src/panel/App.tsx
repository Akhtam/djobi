/**
 * The side panel shell (mounted by `panel/main.tsx`). It owns only the Profile bootstrap, the tab
 * switch, and the hand-off from a question card to the Ask Tab; each flow is its own module
 * (`AutofillTab`, `LogApplication`, `AskTab`).
 *
 * The run is `useActiveRun`'s (the Autofill and Ask tabs share one copy); the shell only shows its
 * header pill. `client` is a prop so tests drive the whole panel through a fake. The panel survives
 * tab switches and re-tracks the active tab.
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

/**
 * Where the Profile bootstrap has got to. Everything past it belongs to a tab, not to the shell.
 */
type BootstrapStatus = 'loading' | 'unauthorized' | 'profile-error' | 'no-profile' | 'ready';

/**
 * Why `getProfile` failed. A 401 that survived session recovery means "sign in", not "backend
 * broken", so the two get different copy.
 */
type ProfileLoadError = { kind: 'unauthorized' } | { kind: 'other'; message: string };

/**
 * Which flow is showing. Tabs, not modes: Log and Ask share no pipeline state. Ask works at any
 * point, even with no run; a question card can seed it and receive the answer back.
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
        // Session recovery (adopt the dashboard session, retry once on 401) is inside `client`.
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
   * Hands one drafted answer to the Ask Tab. The Autofill Tab decides which answers qualify
   * (freeform only).
   */
  function refineAnswer(fieldId: string, question: string, currentAnswer: string) {
    const runId = activeRun.run?.runId;
    if (!runId) return;
    setAskSeed({ runId, fieldId, question, currentAnswer, token: ++askSeedTokenRef.current });
    setTab('ask');
  }

  // The pill describes the pipeline run, so it shows only on the Autofill tab and only after
  // bootstrap (a hydrated run shouldn't flash before we know there's a Profile).
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
