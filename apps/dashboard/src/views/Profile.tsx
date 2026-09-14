/**
 * The account-profile editor — `#/profile`, reachable from the header's account menu.
 *
 * The same Profile the extension's options page edits (`apps/extension/src/options/App.tsx`), and
 * deliberately built the same way: everything that is not markup comes from `@djobi/profile-editor`
 * rather than being re-implemented here — the load/upload/save workflow (`useProfileWorkflow`),
 * every list section's editor (`profileListEditors`), the per-field operations
 * (`spliceWorkBullets`, `commaList`, …), and the section inventory (`PROFILE_SECTIONS`).
 * "Star a bullet" and "drop a blank story id" therefore behave identically in both places by
 * construction rather than by both being written the same way twice.
 *
 * What stays here is the chrome: the `FieldChrome`/`ListSectionChrome` this page renders through
 * (`ListSection` itself is `@djobi/profile-editor`'s now — see its own doc comment), the tab bar,
 * the quick-nav's rendering (the *order* is the package's), the save affordance, and how a 401 is
 * reported — the `onUnauthorized` convention `Analytics.tsx` uses, rather than the options page's
 * own `unauthorized`-state-and-`<Login>` one, since the dashboard already redirects to `#/login`
 * centrally in `App.tsx`.
 */
import { useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { userMessage } from '@djobi/http-client';
import type { ExtractedProfile, Profile } from '@djobi/shared';
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

/**
 * This page's `FieldChrome`: a plain wrapping `<label>` with no `id` (implicit label association),
 * and every control carries the `search` class. The extension's own renderer instead uses an
 * explicit `<label htmlFor>` beside its control and no input class — see
 * `apps/extension/src/options/App.tsx`.
 */
const Field: FieldRenderer = ({ label, span2, children }) => (
  <label className={`profile-field${span2 ? ' profile-field--span-2' : ''}`}>
    {label}
    {children}
  </label>
);

const Checkbox: CheckboxFieldRenderer = ({ label, checked, onChange }) => (
  <label className="profile-checkbox-field">
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    {label}
  </label>
);

const fieldChrome: FieldChrome = { Field, Checkbox, controlClassName: 'search' };

/** `profile-star` only applies to work experience — a project's bullets have no star button. */
const workBulletListClassNames: BulletListClassNames = {
  list: 'profile-bullets',
  row: 'profile-bullet-row',
  starButton: 'profile-star',
  removeButton: 'button profile-remove',
  addButton: 'button',
};
const projectBulletListClassNames: BulletListClassNames = {
  list: 'profile-bullets',
  row: 'profile-bullet-row',
  removeButton: 'button profile-remove',
  addButton: 'button',
};

/** A panel's head — anchored by `id` for the quick-nav to scroll to, always expanded. */
function PanelHead({ id, legend, hint }: { id: string; legend: string; hint?: string }) {
  return (
    <div id={id} className="detail__panel-head">
      <h2>{legend}</h2>
      {hint ? <p className="profile-hint">{hint}</p> : null}
    </div>
  );
}

/**
 * This page's `ListSectionChrome`: a plain `<section>` with `PanelHead` and no item count, and an
 * entry whose `summary` renders as an always-visible paragraph, never collapsing. The extension's
 * own renderer instead shows a count and collapses behind a native `<details>` — see
 * `apps/extension/src/options/App.tsx`.
 */
const listSectionChrome: ListSectionChrome = {
  emptyClassName: 'profile-empty',
  addButtonClassName: 'button',
  Section: ({ id, legend, hint, children }) => (
    <section className="detail__panel">
      <PanelHead id={id} legend={legend} hint={hint} />
      <div className="detail__panel-body">{children}</div>
    </section>
  ),
  Entry: ({ index, noun, onRemove, summary, children }) => (
    <div className="profile-entry">
      <div className="profile-entry__head">
        <span>{`Entry ${index + 1}`}</span>
        <button
          type="button"
          className="button profile-remove"
          aria-label={`Remove ${noun} ${index + 1}`}
          onClick={onRemove}
        >
          Remove
        </button>
      </div>
      {summary ? <p className="profile-entry__summary">{summary}</p> : null}
      {children}
    </div>
  ),
};

/** The page's two tabs — everything resume-shaped, versus everything asked at application time. */
type ProfileTab = 'profile' | 'prep';

export function Profile({
  getProfile,
  saveProfile,
  extractResume,
  onUnauthorized,
}: {
  getProfile: () => Promise<Profile | null>;
  saveProfile: (profile: Profile) => Promise<Profile>;
  extractResume: (file: File) => Promise<ExtractedProfile>;
  onUnauthorized: () => void;
}) {
  const port = useMemo<ProfilePagePort>(
    () => ({ loadProfile: getProfile, saveProfile, extractResume }),
    [getProfile, saveProfile, extractResume],
  );
  const workflow = useProfileWorkflow(port, onUnauthorized);
  const { draft, setProfile, newSkill, setNewSkill, saveResult, uploadResult, loadError } =
    workflow;
  const { profile, dirty, extracting } = draft;
  const [activeTab, setActiveTab] = useState<ProfileTab>('profile');
  // The upload button opens the file picker by proxy — the real `<input type="file">` is visually
  // hidden so this can be a normal styled button rather than the browser's own file-input chrome.
  const resumeInputRef = useRef<HTMLInputElement>(null);

  const status = saveResult
    ? {
        kind: saveResult.kind === 'saved' ? 'saved' : 'error',
        message: profileOutcomeMessage(saveResult),
      }
    : null;
  const extraction = uploadResult
    ? {
        kind: uploadResult.kind === 'parsed' ? 'notice' : 'error',
        message: profileOutcomeMessage(uploadResult),
      }
    : null;

  if (!profile) {
    return <p className="empty-state">Loading profile…</p>;
  }

  const editors = profileListEditors(profile, setProfile);
  const { work, education, stories, customAnswers, projects, credentials } = editors;
  const section = PROFILE_SECTION_BY_KEY;

  async function handleResumeUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Cleared immediately so re-selecting the same file still fires a change event.
    event.target.value = '';
    if (file) await workflow.uploadResume(file);
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    await workflow.save();
  }

  return (
    <article className="detail profile-page">
      <a className="back-link" href="#/">
        ← Applications
      </a>

      <header className="detail__header-card">
        <div>
          <h1>Your profile</h1>
          <p className="detail__subtitle">
            djobi tailors your resume and drafts your answers from what's here, and only from what's
            here — it won't make anything up.
          </p>
        </div>
      </header>

      {loadError !== null ? (
        <p className="banner banner--error" role="alert">
          Couldn’t load your profile. {userMessage(loadError)}
        </p>
      ) : null}

      <section className="detail__panel">
        <PanelHead id={section.upload.anchor} legend={section.upload.title} />
        <div className="detail__panel-body">
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
          {extraction ? (
            <p
              className={`profile-status profile-status--${extraction.kind === 'error' ? 'error' : 'saved'}`}
              role={extraction.kind === 'error' ? 'alert' : 'status'}
            >
              {extraction.message}
            </p>
          ) : null}
        </div>
      </section>

      <div className="profile-nav-sticky">
        <div className="profile-tabbar" role="tablist" aria-label="Profile tabs">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'profile'}
            className={`profile-tab${activeTab === 'profile' ? ' profile-tab--active' : ''}`}
            onClick={() => setActiveTab('profile')}
          >
            Profile
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'prep'}
            className={`profile-tab${activeTab === 'prep' ? ' profile-tab--active' : ''}`}
            onClick={() => setActiveTab('prep')}
          >
            Screening and Stories
          </button>
        </div>
        <nav className="profile-quicknav" aria-label="Profile sections">
          {PROFILE_SECTIONS.filter((panel) => panel.group === activeTab).map((panel) => (
            <button
              key={panel.anchor}
              type="button"
              className="profile-quicknav__link"
              onClick={() => scrollToSection(panel.anchor)}
            >
              {panel.label}
            </button>
          ))}
        </nav>
      </div>

      <form onSubmit={handleSave}>
        {activeTab === 'profile' && (
          <>
            <section className="detail__panel">
              <PanelHead id={section.contact.anchor} legend={section.contact.title} />
              <div className="detail__panel-body">
                <div className="profile-field-grid">
                  <ProfileSectionFields
                    section="contact"
                    chrome={fieldChrome}
                    profile={profile}
                    onChange={setProfile}
                  />
                </div>
              </div>
            </section>

            <section className="detail__panel">
              <PanelHead id={section.links.anchor} legend={section.links.title} />
              <div className="detail__panel-body">
                <div className="profile-field-grid">
                  <ProfileSectionFields
                    section="links"
                    chrome={fieldChrome}
                    profile={profile}
                    onChange={setProfile}
                  />
                </div>
              </div>
            </section>

            <section className="detail__panel">
              <PanelHead
                id={section.summary.anchor}
                legend={section.summary.title}
                hint={section.summary.hint}
              />
              <div className="detail__panel-body">
                <ProfileSectionFields
                  section="summary"
                  chrome={fieldChrome}
                  profile={profile}
                  onChange={setProfile}
                />
              </div>
            </section>

            <section className="detail__panel">
              <PanelHead
                id={section.resume.anchor}
                legend={section.resume.title}
                hint={section.resume.hint}
              />
              <div className="detail__panel-body">
                <div className="profile-field-grid">
                  <ProfileSectionFields
                    section="resume"
                    chrome={fieldChrome}
                    profile={profile}
                    onChange={setProfile}
                  />
                </div>
              </div>
            </section>

            <section className="detail__panel">
              <PanelHead id={section.skills.anchor} legend={section.skills.title} />
              <div className="detail__panel-body">
                <ul className="profile-skills">
                  {profile.skills.map((skill) => (
                    <li key={skill} className="profile-skill-chip">
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
                <div className="profile-skill-add">
                  <label className="profile-field">
                    New skill
                    <input
                      className="search"
                      value={newSkill}
                      onChange={(e) => setNewSkill(e.target.value)}
                    />
                  </label>
                  <button type="button" className="button" onClick={workflow.addNewSkill}>
                    Add skill
                  </button>
                </div>
              </div>
            </section>

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
                <label className="profile-field profile-field--cap">
                  Default bullets per role
                  <input
                    className="search"
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
                </label>
              }
              summary={(entry) => {
                const identity =
                  entry.title || entry.company
                    ? `${entry.title || 'Role'}${entry.company ? ` at ${entry.company}` : ''}`
                    : null;
                const starred = entry.starredIndices.length;
                return identity
                  ? `${identity} — ${entry.bullets.length} ${entry.bullets.length === 1 ? 'bullet' : 'bullets'} · ${starred} starred`
                  : null;
              }}
            >
              {profileListSectionEntry('work', {
                chrome: fieldChrome,
                editors,
                wrapperClassName: 'profile-field-grid',
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
                wrapperClassName: 'profile-field-grid',
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
                wrapperClassName: 'profile-field-grid',
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
                wrapperClassName: 'profile-field-grid',
                maxBulletsPerRole: profile.maxBulletsPerRole,
              })}
            </ListSection>
          </>
        )}

        {activeTab === 'prep' && (
          <>
            <section className="detail__panel">
              <PanelHead
                id={section.screening.anchor}
                legend={section.screening.title}
                hint={section.screening.hint}
              />
              <div className="detail__panel-body">
                <div className="profile-field-grid">
                  <ProfileSectionFields
                    section="screening"
                    chrome={fieldChrome}
                    profile={profile}
                    onChange={setProfile}
                  />
                </div>
              </div>
            </section>

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
                wrapperClassName: 'profile-field-grid',
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
                wrapperClassName: 'profile-field-grid',
                maxBulletsPerRole: profile.maxBulletsPerRole,
              })}
            </ListSection>
          </>
        )}

        <div className="profile-footer">
          <div>
            {status ? (
              <p
                className={`profile-status profile-status--${status.kind}`}
                role={status.kind === 'error' ? 'alert' : 'status'}
              >
                {status.message}
              </p>
            ) : (
              <p className="profile-hint">
                {dirty ? 'You have unsaved changes.' : 'Changes are saved to your profile.'}
              </p>
            )}
          </div>
          <button type="submit" className="button button--primary" disabled={draft.saving}>
            {draft.saving ? 'Saving…' : 'Save profile'}
          </button>
        </div>
      </form>
    </article>
  );
}
