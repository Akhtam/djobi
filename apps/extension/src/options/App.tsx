/**
 * Options page root — the profile onboarding form, and the only surface that edits a Profile.
 *
 * `client` is a prop for the same reason it is one in `panel/App.tsx`: the page is tested through
 * a fake adapter at the backend seam, and `options/main.tsx` is the only place the real one is
 * named.
 */
import { EMPTY_PROFILE, parseProfile, type Profile } from '@djobi/shared';
import {
  addSkill,
  ContactFields,
  CredentialEntryFields,
  CustomAnswerEntryFields,
  EducationEntryFields,
  LinksFields,
  profileListEditors,
  PROFILE_SECTIONS,
  ProjectEntryFields,
  removeSkill,
  ResumeSettingsFields,
  ScreeningAnswerFields,
  scrollToSection,
  StoryEntryFields,
  SummaryField,
  useProfileDraft,
  WorkExperienceEntryFields,
  type BulletListClassNames,
  type CheckboxFieldRenderer,
  type CredentialItem,
  type FieldChrome,
  type FieldRenderer,
  type ListEditor,
} from '@djobi/profile-editor';
import { useEffect, useRef, useState } from 'react';
import './App.css';
import icon48 from '../assets/icons/icon48.png';
import { withSharedSessionRetry } from '../lib/authClient';
import type { BackendClient } from '../lib/backendClient';
import { isUnauthorized, userMessage } from '../lib/callBackend';
import { ThemeToggle, useThemePreference } from '../lib/theme';
import { Login } from './Login';

/**
 * This page's `FieldChrome`: a `.field` div with its own `<label htmlFor>`, no input class (styled
 * by its `.field` ancestor instead — see `App.css`). The dashboard's own renderer wraps the same
 * field bodies in a plain `<label>` instead; see `apps/dashboard/src/views/Profile.tsx`.
 */
const Field: FieldRenderer = ({ id, label, span2, children }) => (
  <div className={`field${span2 ? ' span-2' : ''}`}>
    <label htmlFor={id}>{label}</label>
    {children}
  </div>
);

const Checkbox: CheckboxFieldRenderer = ({ id, label, checked, onChange }) => (
  <label className="checkbox-field" htmlFor={id}>
    <input
      id={id}
      type="checkbox"
      checked={checked}
      onChange={(event) => onChange(event.currentTarget.checked)}
    />
    {label}
  </label>
);

const fieldChrome: FieldChrome = { Field, Checkbox };

/** Class names `bullet-list`/`bullet-row` are scoped in `App.css`; `btn-star` only applies to work. */
const workBulletListClassNames: BulletListClassNames = {
  list: 'bullet-list',
  row: 'bullet-row',
  starButton: 'btn-star',
  removeButton: 'btn-remove-bullet',
  addButton: 'btn-add-inline',
};
const projectBulletListClassNames: BulletListClassNames = {
  list: 'bullet-list',
  row: 'bullet-row',
  removeButton: 'btn-remove-bullet',
  addButton: 'btn-add-inline',
};

/**
 * The chrome around one editable list: the card, its legend and hint, a numbered removable card per
 * entry, and the add button.
 *
 * Only the fields inside an entry actually differ between the four sections, so only those are
 * passed in. `noun` drives both the visible labels and the remove button's accessible name, which
 * is how the tests address a specific entry.
 */
function ListSection<T>({
  id,
  legend,
  noun,
  addLabel,
  hint,
  items,
  editor,
  controls,
  summary,
  children,
}: {
  id: string;
  legend: string;
  noun: string;
  addLabel: string;
  hint?: string;
  items: T[];
  editor: ListEditor<T>;
  controls?: React.ReactNode;
  summary?: (entry: T, index: number) => React.ReactNode;
  children: (entry: T, index: number) => React.ReactNode;
}) {
  return (
    <fieldset id={id} className="card">
      <legend>{legend}</legend>
      <div className="section-meta">
        {hint ? <p className="hint">{hint}</p> : <span />}
        <span className="entry-count">{items.length}</span>
      </div>
      {controls}
      {items.length === 0 && <p className="empty-list">No {noun} added yet.</p>}
      {items.map((entry, index) => {
        const content = (
          <>
            <div className="entry-card-header">
              <span>{`Entry ${index + 1}`}</span>
              <button
                type="button"
                className="btn-danger-ghost"
                aria-label={`Remove ${noun} ${index + 1}`}
                onClick={() => editor.remove(index)}
              >
                Remove
              </button>
            </div>
            {children(entry, index)}
          </>
        );
        return (
          <fieldset key={index} className="entry-card">
            <legend>{`${noun} ${index + 1}`}</legend>
            {summary ? (
              <details className="entry-details" open>
                <summary>{summary(entry, index)}</summary>
                <div className="entry-details-body">{content}</div>
              </details>
            ) : (
              content
            )}
          </fieldset>
        );
      })}
      <button type="button" className="btn-add" onClick={editor.add}>
        {addLabel}
      </button>
    </fieldset>
  );
}

export function App({ client }: { client: BackendClient }) {
  const { theme, toggleTheme } = useThemePreference();
  const draft = useProfileDraft();
  const profile = draft.profile;
  const dirty = draft.dirty;
  const extracting = draft.extracting;
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; message: string } | null>(null);
  const [newSkill, setNewSkill] = useState('');
  // Separate from `status` above: that banner means "the save you just asked for landed or
  // didn't," and an extraction is neither — nothing has been saved yet, and won't be until the
  // candidate reviews what got filled in and clicks Save themselves.
  const [extraction, setExtraction] = useState<{
    kind: 'notice' | 'error';
    message: string;
  } | null>(null);
  // The upload button opens the file picker by proxy — the real `<input type="file">` is visually
  // hidden so this can be a normal styled button rather than the browser's own file-input chrome.
  const resumeInputRef = useRef<HTMLInputElement>(null);
  // Set on a 401 from `getProfile` rather than surfaced through `status` — an absent or expired
  // session is "go sign in again," not "the backend is broken," and this is what routes to `Login`
  // below instead of a generic error banner over an unusable empty form.
  const [unauthorized, setUnauthorized] = useState(false);
  // Bumped by `handleSignIn` to force the fetch effect below to run again once a fresh sign-in has
  // replaced the session that expired.
  const [reloadToken, setReloadToken] = useState(0);

  function setProfile(next: Profile) {
    draft.setProfile(next);
    if (status?.kind === 'saved') setStatus(null);
  }

  useEffect(() => {
    let current = true;

    async function load() {
      try {
        // `parseProfile` completes a stored profile against the empty one and validates it, so a
        // profile saved before a field existed can't crash the form that binds to that key.
        // `withSharedSessionRetry` gives this its one shot at recovery — the dashboard may
        // already have a session (`authClient.ts`'s `adoptSharedSession`) — before a 401 here
        // means there really is nothing to sign in with.
        const loaded = await withSharedSessionRetry(() => client.getProfile());
        if (!current) return;
        setUnauthorized(false);
        draft.load(parseProfile(loaded));
      } catch (error: unknown) {
        if (!current) return;
        if (isUnauthorized(error)) {
          setUnauthorized(true);
          return;
        }
        draft.load(EMPTY_PROFILE);
        setStatus({ kind: 'error', message: `Failed to load profile: ${userMessage(error)}` });
      }
    }

    void load();
    return () => {
      current = false;
    };
    // `draft` is a fresh object every render (its own state setters are stable, but the object
    // wrapping them isn't) — depending on it would re-run this on every render. `client`/
    // `reloadToken` are this effect's real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, reloadToken]);

  async function handleSignIn(email: string, password: string) {
    await client.signIn(email, password);
    setReloadToken((token) => token + 1);
  }

  /*
    `setUnauthorized(true)` directly, not another `reloadToken` bump: bumping would re-run the fetch
    effect and let its own 401 discover the session is gone, but the session is already known gone
    here — the whole point of asking to sign out — so there's nothing to round-trip for.
  */
  async function handleSignOut() {
    await client.signOut();
    setUnauthorized(true);
  }

  if (unauthorized) {
    return <Login onSignIn={handleSignIn} />;
  }

  if (!profile) {
    return (
      <main className="page page-loading">
        <p>Loading…</p>
      </main>
    );
  }

  const { work, education, stories, customAnswers, projects, credentials } = profileListEditors(
    profile,
    setProfile,
  );

  /**
   * Parses the uploaded resume and applies whatever it found onto the draft — never saved on its
   * own. `setProfile` marks the form `dirty`, so "You have unsaved changes" already tells the
   * candidate the normal way nothing has been persisted yet; `extraction` here is only the
   * upload's own success/failure message, not a save confirmation.
   */
  async function handleResumeUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Cleared immediately so re-selecting the same file (after fixing nothing and trying again)
    // still fires a change event.
    e.target.value = '';
    if (!file) return;

    setExtraction(null);
    // `draft.applyResume` owns the protocol — parse, apply field by field onto the draft as it
    // stands when the parse returns, mark it dirty. What's left here is what only this page can
    // answer: how a 401 is reported, and the wording of the result.
    const outcome = await draft.applyResume(file, (upload) => client.extractResume(upload));
    if (outcome.kind === 'stale') return;
    if (outcome.kind === 'error') {
      if (isUnauthorized(outcome.error)) {
        setUnauthorized(true);
        return;
      }
      setExtraction({
        kind: 'error',
        message: `Couldn't parse this resume: ${userMessage(outcome.error)}`,
      });
      return;
    }
    // A parse is an edit, and `applyResume` writes through the draft rather than the `setProfile`
    // wrapper below, so the stale "Profile saved." banner is cleared here instead.
    if (status?.kind === 'saved') setStatus(null);
    setExtraction({
      kind: 'notice',
      message: 'Resume parsed. Review the pre-filled fields below, then save.',
    });
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!profile) return;
    setStatus(null);
    // `draft.save` owns the whole protocol — normalize, persist, drop a response a later edit has
    // superseded, load what came back. What's left here is what only this page can answer: how a
    // 401 is reported, and the wording of the result.
    const outcome = await draft.save((toSave) => client.saveProfile(toSave));
    if (outcome.kind === 'stale') return;
    if (outcome.kind === 'error') {
      if (isUnauthorized(outcome.error)) {
        setUnauthorized(true);
        return;
      }
      setStatus({ kind: 'error', message: userMessage(outcome.error) });
      return;
    }
    setStatus({ kind: 'saved', message: 'Profile saved.' });
  }

  return (
    <main className="page">
      <header className="page-header">
        <div className="brand">
          <img src={icon48} alt="" className="brand-mark" />
          <div>
            <h1>djobi</h1>
            <p className="subtitle">Profile</p>
          </div>
        </div>
        <div className="header-actions">
          <button type="button" className="btn-secondary" onClick={handleSignOut}>
            Sign out
          </button>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>
      <section className="profile-intro" aria-labelledby="profile-title">
        <div>
          <p className="eyebrow">Application profile</p>
          <h2 id="profile-title">Your reusable career record</h2>
          <p>
            Keep this accurate and specific. Djobi uses it to tailor resumes and prepare application
            answers without inventing details.
          </p>
        </div>
        <span className="profile-intro-badge">One profile, every application</span>
      </section>
      <nav className="section-quicknav" aria-label="Profile sections">
        {PROFILE_SECTIONS.map((panel) => (
          <button
            key={panel.anchor}
            type="button"
            className="section-quicknav-link"
            onClick={() => scrollToSection(panel.anchor)}
          >
            {panel.label}
          </button>
        ))}
      </nav>
      <form onSubmit={handleSave}>
        <fieldset id="section-upload" className="card">
          <legend>Upload resume</legend>
          <div className="upload-resume-card">
            <button
              type="button"
              className="upload-resume-card__icon"
              aria-label={extracting ? 'Parsing resume…' : 'Upload resume'}
              onClick={() => resumeInputRef.current?.click()}
              disabled={extracting}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 3v12" />
                <path d="M7 8l5-5 5 5" />
                <path d="M5 21h14" />
              </svg>
            </button>
            <div className="upload-resume-card__text">
              <p className="upload-resume-card__title">Have a resume already?</p>
              <p className="upload-resume-card__hint">
                {extracting
                  ? 'Parsing…'
                  : "PDF — we'll pull contact info, work history, and skills automatically."}
              </p>
            </div>
            <input
              ref={resumeInputRef}
              type="file"
              accept="application/pdf"
              aria-label="Resume PDF"
              className="visually-hidden"
              onChange={handleResumeUpload}
              disabled={extracting}
            />
          </div>
          {extraction && (
            <p
              className={`status-pill ${extraction.kind === 'error' ? 'error' : 'saved'}`}
              role={extraction.kind === 'error' ? 'alert' : 'status'}
            >
              {extraction.message}
            </p>
          )}
        </fieldset>

        <section id="section-contact" className="card contact-card" aria-labelledby="contact-title">
          <div className="card-heading">
            <div>
              <p className="eyebrow">Essentials</p>
              <h3 id="contact-title">Contact details</h3>
            </div>
            <p>Used for form fields and the resume header.</p>
          </div>
          <div className="field-grid">
            <ContactFields chrome={fieldChrome} profile={profile} onChange={setProfile} />
          </div>
        </section>

        <fieldset id="section-links" className="card">
          <legend>Links</legend>
          <div className="field-grid">
            <LinksFields chrome={fieldChrome} profile={profile} onChange={setProfile} />
          </div>
        </fieldset>

        <fieldset id="section-summary" className="card">
          <legend>Summary</legend>
          <p className="card-hint">A short intro paragraph, shown near the top of the resume.</p>
          <SummaryField chrome={fieldChrome} profile={profile} onChange={setProfile} />
        </fieldset>

        <fieldset id="section-resume" className="card">
          <legend>Resume PDF</legend>
          <p className="card-hint">Formatting used for both resume previews and attachments.</p>
          <div className="field-grid">
            <ResumeSettingsFields chrome={fieldChrome} profile={profile} onChange={setProfile} />
          </div>
        </fieldset>

        <fieldset id="section-skills" className="card">
          <legend>Skills</legend>
          <ul className="skills">
            {profile.skills.map((skill) => (
              <li key={skill} className="skill-chip">
                {skill}
                <button
                  type="button"
                  aria-label={`Remove ${skill}`}
                  onClick={() => setProfile(removeSkill(profile, skill))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <div className="skill-add-row">
            <div className="field">
              <label htmlFor="newSkill">New skill</label>
              <input id="newSkill" value={newSkill} onChange={(e) => setNewSkill(e.target.value)} />
            </div>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setProfile(addSkill(profile, newSkill));
                setNewSkill('');
              }}
            >
              Add skill
            </button>
          </div>
        </fieldset>

        <ListSection
          id="section-work"
          legend="Work experience"
          noun="work experience"
          addLabel="Add work experience"
          hint="Keep the full bullet bank for each role. Star must-keep evidence; tailoring selects the rest up to the cap."
          items={profile.workExperience}
          editor={work}
          controls={
            <div className="selection-controls">
              <div className="field cap-field">
                <label htmlFor="maxBulletsPerRole">Default bullets per role</label>
                <input
                  id="maxBulletsPerRole"
                  type="number"
                  min="0"
                  step="1"
                  value={profile.maxBulletsPerRole}
                  onChange={(event) => {
                    const value = event.currentTarget.valueAsNumber;
                    if (Number.isInteger(value) && value >= 0) {
                      setProfile({ ...profile, maxBulletsPerRole: value });
                    }
                  }}
                />
              </div>
              <p className="hint">
                A maximum, not a target. Roles with fewer bullets stay shorter.
              </p>
            </div>
          }
          summary={(entry, index) => {
            const identity =
              entry.title || entry.company
                ? `${entry.title || 'Role'}${entry.company ? ` at ${entry.company}` : ''}`
                : `Work experience ${index + 1}`;
            const starred = entry.starredIndices.length;
            return (
              <>
                <span className="entry-summary-title">{identity}</span>
                <span className="entry-summary-count">
                  {`${entry.bullets.length} ${entry.bullets.length === 1 ? 'bullet' : 'bullets'} · ${starred} starred`}
                </span>
              </>
            );
          }}
        >
          {(entry, index) => (
            <div className="field-grid">
              <WorkExperienceEntryFields
                chrome={fieldChrome}
                bulletListClassNames={workBulletListClassNames}
                entry={entry}
                index={index}
                maxBulletsPerRole={profile.maxBulletsPerRole}
                work={work}
              />
            </div>
          )}
        </ListSection>

        <ListSection
          id="section-projects"
          legend="Projects"
          noun="project"
          addLabel="Add project"
          hint="Personal, open-source or freelance work — anything not covered by Work experience above."
          items={profile.projects}
          editor={projects}
        >
          {(entry, index) => (
            <div className="field-grid">
              <ProjectEntryFields
                chrome={fieldChrome}
                bulletListClassNames={projectBulletListClassNames}
                entry={entry}
                index={index}
                projects={projects}
              />
            </div>
          )}
        </ListSection>

        <ListSection
          id="section-education"
          legend="Education"
          noun="education"
          addLabel="Add education"
          items={profile.education}
          editor={education}
        >
          {(entry, index) => (
            <div className="field-grid">
              <EducationEntryFields
                chrome={fieldChrome}
                entry={entry}
                index={index}
                education={education}
              />
            </div>
          )}
        </ListSection>

        <ListSection
          id="section-credentials"
          legend="Certifications & Awards"
          noun="certification or award"
          addLabel="Add certification or award"
          hint="Pick which each row is — the fields shown adjust to match."
          items={credentials.items}
          editor={credentials.editor}
        >
          {(item, index) => (
            <div className="field-grid">
              <CredentialEntryFields
                chrome={fieldChrome}
                item={item}
                index={index}
                editor={credentials.editor}
                changeKind={credentials.changeKind}
              />
            </div>
          )}
        </ListSection>

        {/* Facts, not prose. Anything answered here is filled straight from the profile and never
            reaches the answer-drafting model — see `@djobi/shared`'s `screeningAnswers.ts`. */}
        <fieldset id="section-screening" className="card screening-card">
          <legend>Screening answers</legend>
          <p className="hint">
            The questions almost every application asks. Anything you answer here is filled in
            directly — the AI is never asked to guess it. Leave a row blank to let it be drafted as
            usual.
          </p>
          <div className="screening-grid">
            <ScreeningAnswerFields chrome={fieldChrome} profile={profile} onChange={setProfile} />
          </div>
        </fieldset>

        <ListSection
          id="section-answers"
          legend="Other prepared answers"
          noun="prepared answer"
          addLabel="Add prepared answer"
          hint="Anything else you're asked repeatedly. The question is matched loosely against the form's own wording, so it needn't be phrased identically."
          items={profile.customAnswers}
          editor={customAnswers}
        >
          {(entry, index) => (
            <CustomAnswerEntryFields
              chrome={fieldChrome}
              entry={entry}
              index={index}
              customAnswers={customAnswers}
            />
          )}
        </ListSection>

        <ListSection
          id="section-stories"
          legend="Stories"
          noun="story"
          addLabel="Add story"
          items={profile.stories}
          editor={stories}
        >
          {(entry, index) => (
            <div className="field-grid">
              <StoryEntryFields
                chrome={fieldChrome}
                entry={entry}
                index={index}
                stories={stories}
              />
            </div>
          )}
        </ListSection>

        <div className="footer-save">
          <div className="save-feedback">
            {status ? (
              <p
                className={`status-pill ${status.kind}`}
                role={status.kind === 'error' ? 'alert' : 'status'}
              >
                {status.message}
              </p>
            ) : (
              <p className="save-hint">
                {dirty ? 'You have unsaved changes.' : 'Changes are saved to your profile.'}
              </p>
            )}
          </div>
          <button type="submit" className="btn-primary" disabled={draft.saving}>
            {draft.saving ? 'Saving…' : 'Save profile'}
          </button>
        </div>
      </form>
    </main>
  );
}
