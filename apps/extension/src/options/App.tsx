/**
 * Options page root — the profile onboarding form, and the only surface that edits a Profile.
 *
 * `client` is a prop for the same reason it is one in `panel/App.tsx`: the page is tested through
 * a fake adapter at the backend seam, and `options/main.tsx` is the only place the real one is
 * named.
 */
import {
  ListSection,
  profileOutcomeMessage,
  profileListEditors,
  profileListSectionEntry,
  PROFILE_SECTION_BY_KEY,
  PROFILE_SECTIONS,
  ProfileSectionFields,
  removeSkill,
  scrollToSection,
  useProfileWorkflow,
  type BulletListClassNames,
  type CheckboxFieldRenderer,
  type CredentialItem,
  type FieldChrome,
  type FieldRenderer,
  type ListSectionChrome,
  type ProfilePagePort,
} from '@djobi/profile-editor';
import { useMemo, useRef, useState } from 'react';
import './App.css';
import icon48 from '../assets/icons/icon48.png';
import type { BackendClient } from '../lib/backendClient';
import { userMessage } from '../lib/callBackend';
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
 * This page's `ListSectionChrome`: a `<fieldset className="card">` showing an item count beside
 * the hint, and an entry that collapses behind its `summary` in a native `<details>` — the
 * dashboard's own renderer shows neither; see `apps/dashboard/src/views/Profile.tsx`.
 */
const listSectionChrome: ListSectionChrome = {
  emptyClassName: 'empty-list',
  addButtonClassName: 'btn-add',
  Section: ({ id, legend, hint, itemCount, children }) => (
    <fieldset id={id} className="card">
      <legend>{legend}</legend>
      <div className="section-meta">
        {hint ? <p className="hint">{hint}</p> : <span />}
        <span className="entry-count">{itemCount}</span>
      </div>
      {children}
    </fieldset>
  ),
  Entry: ({ index, noun, onRemove, summary, children }) => {
    const content = (
      <>
        <div className="entry-card-header">
          <span>{`Entry ${index + 1}`}</span>
          <button
            type="button"
            className="btn-danger-ghost"
            aria-label={`Remove ${noun} ${index + 1}`}
            onClick={onRemove}
          >
            Remove
          </button>
        </div>
        {children}
      </>
    );
    return (
      <fieldset className="entry-card">
        <legend>{`${noun} ${index + 1}`}</legend>
        {summary ? (
          <details className="entry-details" open>
            <summary>{summary}</summary>
            <div className="entry-details-body">{content}</div>
          </details>
        ) : (
          content
        )}
      </fieldset>
    );
  },
};

export function App({ client }: { client: BackendClient }) {
  const { theme, toggleTheme } = useThemePreference();
  // A 401 means "sign in again", not "the backend is broken". Session recovery (adopting a shared
  // dashboard session, retrying once) already happened inside `client` before one reaches here.
  const [unauthorized, setUnauthorized] = useState(false);
  const port = useMemo<ProfilePagePort>(
    () => ({
      loadProfile: () => client.getProfile(),
      saveProfile: (profile) => client.saveProfile(profile),
      extractResume: (file) => client.extractResume(file),
    }),
    [client],
  );
  const workflow = useProfileWorkflow(port, () => setUnauthorized(true));
  const { draft, setProfile, newSkill, setNewSkill, saveResult, uploadResult, loadError } =
    workflow;
  const { profile, dirty, extracting } = draft;
  // The upload button opens the file picker by proxy — the real `<input type="file">` is visually
  // hidden so this can be a normal styled button rather than the browser's own file-input chrome.
  const resumeInputRef = useRef<HTMLInputElement>(null);

  const status = saveResult
    ? {
        kind: saveResult.kind === 'saved' ? 'saved' : 'error',
        message: profileOutcomeMessage(saveResult),
      }
    : loadError !== null
      ? { kind: 'error', message: `Failed to load profile: ${userMessage(loadError)}` }
      : null;
  const extraction = uploadResult
    ? {
        kind: uploadResult.kind === 'parsed' ? 'notice' : 'error',
        message: profileOutcomeMessage(uploadResult),
      }
    : null;

  async function handleSignIn(email: string, password: string) {
    await client.signIn(email, password);
    setUnauthorized(false);
    workflow.reload();
  }

  // No reload here: the session is already known to be gone, so there is nothing to round-trip for.
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

  const editors = profileListEditors(profile, setProfile);
  const { work, education, stories, customAnswers, projects, credentials } = editors;
  const section = PROFILE_SECTION_BY_KEY;

  async function handleResumeUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Cleared immediately so re-selecting the same file still fires a change event.
    e.target.value = '';
    if (file) await workflow.uploadResume(file);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    await workflow.save();
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
          <h2 id="profile-title">Write it once, use it everywhere</h2>
          <p>
            Keep this accurate and specific. djobi tailors your resume and drafts your answers from
            what's here, and only from what's here — it won't make anything up.
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
        <fieldset id={section.upload.anchor} className="card">
          <legend>{section.upload.title}</legend>
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
                  : "Drop in a PDF and we'll pull out your contact details, work history, and skills."}
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

        <section
          id={section.contact.anchor}
          className="card contact-card"
          aria-labelledby="contact-title"
        >
          <div className="card-heading">
            <div>
              <p className="eyebrow">Essentials</p>
              <h3 id="contact-title">{section.contact.title}</h3>
            </div>
            <p>These fill the form and head up your resume.</p>
          </div>
          <div className="field-grid">
            <ProfileSectionFields
              section="contact"
              chrome={fieldChrome}
              profile={profile}
              onChange={setProfile}
            />
          </div>
        </section>

        <fieldset id={section.links.anchor} className="card">
          <legend>{section.links.title}</legend>
          <div className="field-grid">
            <ProfileSectionFields
              section="links"
              chrome={fieldChrome}
              profile={profile}
              onChange={setProfile}
            />
          </div>
        </fieldset>

        <fieldset id={section.summary.anchor} className="card">
          <legend>{section.summary.title}</legend>
          <p className="card-hint">{section.summary.hint}</p>
          <ProfileSectionFields
            section="summary"
            chrome={fieldChrome}
            profile={profile}
            onChange={setProfile}
          />
        </fieldset>

        <fieldset id={section.resume.anchor} className="card">
          <legend>{section.resume.title}</legend>
          <p className="card-hint">{section.resume.hint}</p>
          <div className="field-grid">
            <ProfileSectionFields
              section="resume"
              chrome={fieldChrome}
              profile={profile}
              onChange={setProfile}
            />
          </div>
        </fieldset>

        <fieldset id={section.skills.anchor} className="card">
          <legend>{section.skills.title}</legend>
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
            <button type="button" className="btn-secondary" onClick={workflow.addNewSkill}>
              Add skill
            </button>
          </div>
        </fieldset>

        <ListSection
          chrome={listSectionChrome}
          id={section.work.anchor}
          legend={section.work.title}
          noun={section.work.noun}
          addLabel={section.work.addLabel}
          hint={section.work.hint}
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
                A ceiling, not a target. Roles with fewer bullets stay shorter.
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
          {profileListSectionEntry('work', {
            chrome: fieldChrome,
            editors,
            wrapperClassName: 'field-grid',
            bulletListClassNames: workBulletListClassNames,
            maxBulletsPerRole: profile.maxBulletsPerRole,
          })}
        </ListSection>

        <ListSection
          chrome={listSectionChrome}
          id={section.projects.anchor}
          legend={section.projects.title}
          noun={section.projects.noun}
          addLabel={section.projects.addLabel}
          hint={section.projects.hint}
          items={profile.projects}
          editor={projects}
        >
          {profileListSectionEntry('projects', {
            chrome: fieldChrome,
            editors,
            wrapperClassName: 'field-grid',
            bulletListClassNames: projectBulletListClassNames,
            maxBulletsPerRole: profile.maxBulletsPerRole,
          })}
        </ListSection>

        <ListSection
          chrome={listSectionChrome}
          id={section.education.anchor}
          legend={section.education.title}
          noun={section.education.noun}
          addLabel={section.education.addLabel}
          items={profile.education}
          editor={education}
        >
          {profileListSectionEntry('education', {
            chrome: fieldChrome,
            editors,
            wrapperClassName: 'field-grid',
            maxBulletsPerRole: profile.maxBulletsPerRole,
          })}
        </ListSection>

        <ListSection
          chrome={listSectionChrome}
          id={section.credentials.anchor}
          legend={section.credentials.title}
          noun={section.credentials.noun}
          addLabel={section.credentials.addLabel}
          hint={section.credentials.hint}
          items={credentials.items}
          editor={credentials.editor}
        >
          {profileListSectionEntry('credentials', {
            chrome: fieldChrome,
            editors,
            wrapperClassName: 'field-grid',
            maxBulletsPerRole: profile.maxBulletsPerRole,
          })}
        </ListSection>

        {/* Facts, not prose. Anything answered here is filled straight from the profile and never
            reaches the answer-drafting model — see `@djobi/shared`'s `screeningAnswers.ts`. */}
        <fieldset id={section.screening.anchor} className="card screening-card">
          <legend>{section.screening.title}</legend>
          <p className="hint">{section.screening.hint}</p>
          <div className="screening-grid">
            <ProfileSectionFields
              section="screening"
              chrome={fieldChrome}
              profile={profile}
              onChange={setProfile}
            />
          </div>
        </fieldset>

        <ListSection
          chrome={listSectionChrome}
          id={section.answers.anchor}
          legend={section.answers.title}
          noun={section.answers.noun}
          addLabel={section.answers.addLabel}
          hint={section.answers.hint}
          items={profile.customAnswers}
          editor={customAnswers}
        >
          {profileListSectionEntry('answers', {
            chrome: fieldChrome,
            editors,
            maxBulletsPerRole: profile.maxBulletsPerRole,
          })}
        </ListSection>

        <ListSection
          chrome={listSectionChrome}
          id={section.stories.anchor}
          legend={section.stories.title}
          noun={section.stories.noun}
          addLabel={section.stories.addLabel}
          items={profile.stories}
          editor={stories}
        >
          {profileListSectionEntry('stories', {
            chrome: fieldChrome,
            editors,
            wrapperClassName: 'field-grid',
            maxBulletsPerRole: profile.maxBulletsPerRole,
          })}
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
