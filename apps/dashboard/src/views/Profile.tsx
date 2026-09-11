/**
 * The account-profile editor — `#/profile`, reachable from the header's account menu.
 *
 * The same Profile the extension's options page edits (`apps/extension/src/options/App.tsx`), and
 * deliberately built the same way: everything that is not markup comes from `@djobi/profile-editor`
 * rather than being re-implemented here — the draft (`useProfileDraft`), every list section's
 * editor (`profileListEditors`), the per-field operations (`spliceWorkBullets`, `commaList`,
 * `addSkill`, …), the section inventory (`PROFILE_SECTIONS`), and the save and resume-upload
 * protocols, which are `draft.save`/`draft.applyResume` rather than sequences this view repeats.
 * "Star a bullet" and "drop a blank story id" therefore behave identically in both places by
 * construction rather than by both being written the same way twice.
 *
 * What stays here is the chrome: `ListSection`'s panel shell, the tab bar, the quick-nav's
 * rendering (the *order* is the package's), the save affordance, and how a 401 is reported — the
 * `onUnauthorized` convention `Analytics.tsx` uses, rather than the options page's own
 * `unauthorized`-state-and-`<Login>` one, since the dashboard already redirects to `#/login`
 * centrally in `App.tsx`.
 */
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import { isUnauthorized, userMessage } from '@djobi/http-client';
import { EMPTY_PROFILE, parseProfile, type ExtractedProfile, type Profile } from '@djobi/shared';
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

/** The chrome around one editable list: the panel, its hint, a numbered removable entry, and Add. */
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
  controls?: ReactNode;
  summary?: (entry: T, index: number) => ReactNode;
  children: (entry: T, index: number) => ReactNode;
}) {
  return (
    <section className="detail__panel">
      <PanelHead id={id} legend={legend} hint={hint} />
      <div className="detail__panel-body">
        {controls}
        {items.length === 0 && <p className="profile-empty">No {noun} added yet.</p>}
        {items.map((entry, index) => (
          <div key={index} className="profile-entry">
            <div className="profile-entry__head">
              <span>{`Entry ${index + 1}`}</span>
              <button
                type="button"
                className="button profile-remove"
                aria-label={`Remove ${noun} ${index + 1}`}
                onClick={() => editor.remove(index)}
              >
                Remove
              </button>
            </div>
            {summary ? <p className="profile-entry__summary">{summary(entry, index)}</p> : null}
            {children(entry, index)}
          </div>
        ))}
        <button type="button" className="button" onClick={editor.add}>
          {addLabel}
        </button>
      </div>
    </section>
  );
}

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
  const draft = useProfileDraft();
  const profile = draft.profile;
  const dirty = draft.dirty;
  const extracting = draft.extracting;
  const [activeTab, setActiveTab] = useState<ProfileTab>('profile');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; message: string } | null>(null);
  const [newSkill, setNewSkill] = useState('');
  // Separate from `status` above: that means "the save you just asked for landed or didn't," and
  // an extraction is neither — nothing is saved until the candidate reviews the pre-filled fields
  // and clicks Save themselves.
  const [extraction, setExtraction] = useState<{
    kind: 'notice' | 'error';
    message: string;
  } | null>(null);
  // The upload button opens the file picker by proxy — the real `<input type="file">` is visually
  // hidden so this can be a normal styled button rather than the browser's own file-input chrome.
  const resumeInputRef = useRef<HTMLInputElement>(null);

  function setProfile(next: Profile) {
    draft.setProfile(next);
    if (status?.kind === 'saved') setStatus(null);
  }

  useEffect(() => {
    let current = true;
    getProfile().then(
      (loaded) => {
        if (!current) return;
        draft.load(parseProfile(loaded));
      },
      (error: unknown) => {
        if (!current) return;
        if (isUnauthorized(error)) {
          onUnauthorized();
          return;
        }
        draft.load(EMPTY_PROFILE);
        setLoadError(userMessage(error));
      },
    );
    return () => {
      current = false;
    };
    // `draft` is a fresh object every render — depending on it would re-run this on every render.
    // `getProfile`/`onUnauthorized` are this effect's real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getProfile, onUnauthorized]);

  if (!profile) {
    return <p className="empty-state">Loading profile…</p>;
  }

  const { work, education, stories, customAnswers, projects, credentials } = profileListEditors(
    profile,
    setProfile,
  );

  /**
   * Parses the uploaded resume and applies whatever it found onto the draft — never saved on its
   * own. `setProfile` marks the form `dirty`, so "You have unsaved changes" already says nothing
   * has been persisted yet; `extraction` here is only the upload's own success/failure message.
   */
  async function handleResumeUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Cleared immediately so re-selecting the same file still fires a change event.
    event.target.value = '';
    if (!file) return;

    setExtraction(null);
    // `draft.applyResume` owns the protocol — parse, apply field by field onto the draft as it
    // stands when the parse returns, mark it dirty. What's left here is what only this view can
    // answer: how a 401 is reported, and the wording of the result.
    const outcome = await draft.applyResume(file, extractResume);
    if (outcome.kind === 'stale') return;
    if (outcome.kind === 'error') {
      if (isUnauthorized(outcome.error)) {
        onUnauthorized();
        return;
      }
      setExtraction({
        kind: 'error',
        message: `Couldn't parse this resume: ${userMessage(outcome.error)}`,
      });
      return;
    }
    // A parse is an edit, and `applyResume` writes through the draft rather than the `setProfile`
    // wrapper above, so the stale "Profile saved." banner is cleared here instead.
    if (status?.kind === 'saved') setStatus(null);
    setExtraction({
      kind: 'notice',
      message: 'Resume parsed. Review the pre-filled fields below, then save.',
    });
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!profile) return;
    setStatus(null);
    // `draft.save` owns the whole protocol — normalize, persist, drop a response a later edit has
    // superseded, load what came back. What's left here is what only this view can answer: how a
    // 401 is reported, and the wording of the result.
    const outcome = await draft.save(saveProfile);
    if (outcome.kind === 'stale') return;
    if (outcome.kind === 'error') {
      if (isUnauthorized(outcome.error)) {
        onUnauthorized();
        return;
      }
      setStatus({ kind: 'error', message: userMessage(outcome.error) });
      return;
    }
    setStatus({ kind: 'saved', message: 'Profile saved.' });
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
            Djobi uses this to tailor resumes and prepare application answers without inventing
            details.
          </p>
        </div>
      </header>

      {loadError ? (
        <p className="banner banner--error" role="alert">
          Couldn’t load your profile. {loadError}
        </p>
      ) : null}

      <section className="detail__panel">
        <PanelHead id="section-upload" legend="Upload resume" />
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
              <PanelHead id="section-contact" legend="Contact details" />
              <div className="detail__panel-body">
                <div className="profile-field-grid">
                  <ContactFields chrome={fieldChrome} profile={profile} onChange={setProfile} />
                </div>
              </div>
            </section>

            <section className="detail__panel">
              <PanelHead id="section-links" legend="Links" />
              <div className="detail__panel-body">
                <div className="profile-field-grid">
                  <LinksFields chrome={fieldChrome} profile={profile} onChange={setProfile} />
                </div>
              </div>
            </section>

            <section className="detail__panel">
              <PanelHead
                id="section-summary"
                legend="Summary"
                hint="A short intro paragraph, shown near the top of the resume."
              />
              <div className="detail__panel-body">
                <SummaryField chrome={fieldChrome} profile={profile} onChange={setProfile} />
              </div>
            </section>

            <section className="detail__panel">
              <PanelHead
                id="section-resume"
                legend="Resume PDF"
                hint="Formatting used for both resume previews and attachments."
              />
              <div className="detail__panel-body">
                <div className="profile-field-grid">
                  <ResumeSettingsFields
                    chrome={fieldChrome}
                    profile={profile}
                    onChange={setProfile}
                  />
                </div>
              </div>
            </section>

            <section className="detail__panel">
              <PanelHead id="section-skills" legend="Skills" />
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
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      setProfile(addSkill(profile, newSkill));
                      setNewSkill('');
                    }}
                  >
                    Add skill
                  </button>
                </div>
              </div>
            </section>

            <ListSection
              id="section-work"
              legend="Work experience"
              noun="work experience"
              addLabel="Add work experience"
              hint="Keep the full bullet bank for each role. Star must-keep evidence; tailoring selects the rest up to the cap."
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
              {(entry, index) => (
                <div className="profile-field-grid">
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
                <div className="profile-field-grid">
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
                <div className="profile-field-grid">
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
                <div className="profile-field-grid">
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
          </>
        )}

        {activeTab === 'prep' && (
          <>
            <section className="detail__panel">
              <PanelHead
                id="section-screening"
                legend="Screening answers"
                hint="The questions almost every application asks. Anything answered here is filled in directly — the AI is never asked to guess it. Leave a row blank to let it be drafted as usual."
              />
              <div className="detail__panel-body">
                <div className="profile-field-grid">
                  <ScreeningAnswerFields
                    chrome={fieldChrome}
                    profile={profile}
                    onChange={setProfile}
                  />
                </div>
              </div>
            </section>

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
                <div className="profile-field-grid">
                  <CustomAnswerEntryFields
                    chrome={fieldChrome}
                    entry={entry}
                    index={index}
                    customAnswers={customAnswers}
                  />
                </div>
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
                <div className="profile-field-grid">
                  <StoryEntryFields
                    chrome={fieldChrome}
                    entry={entry}
                    index={index}
                    stories={stories}
                  />
                </div>
              )}
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
