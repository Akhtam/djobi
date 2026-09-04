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
import {
  EMPTY_PROFILE,
  failureMessage,
  parseProfile,
  SCREENING_TOPICS,
  type ExtractedProfile,
  type Profile,
} from '@djobi/shared';
import {
  addSkill,
  commaList,
  optionalList,
  optionalText,
  parseBulletCap,
  profileListEditors,
  PROFILE_SECTIONS,
  removeSkill,
  scrollToSection,
  spliceProjectBullets,
  spliceWorkBullets,
  toggleStarredBullet,
  useProfileDraft,
  withScreeningAnswer,
  type CredentialItem,
  type ListEditor,
} from '@djobi/profile-editor';
import { isUnauthorized } from '../lib/dashboardSession';

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
        setLoadError(failureMessage(error));
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
        message: `Couldn't parse this resume: ${failureMessage(outcome.error)}`,
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
      setStatus({ kind: 'error', message: failureMessage(outcome.error) });
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
                  <label className="profile-field">
                    Full name
                    <input
                      className="search"
                      autoComplete="name"
                      value={profile.fullName}
                      onChange={(e) => setProfile({ ...profile, fullName: e.target.value })}
                    />
                  </label>
                  <label className="profile-field">
                    Email
                    <input
                      className="search"
                      type="email"
                      autoComplete="email"
                      value={profile.email}
                      onChange={(e) => setProfile({ ...profile, email: e.target.value })}
                    />
                  </label>
                  <label className="profile-field">
                    Phone
                    <input
                      className="search"
                      type="tel"
                      autoComplete="tel"
                      value={profile.phone ?? ''}
                      onChange={(e) =>
                        setProfile({ ...profile, phone: optionalText(e.target.value) })
                      }
                    />
                  </label>
                  <label className="profile-field">
                    Location
                    <input
                      className="search"
                      autoComplete="address-level2"
                      value={profile.location ?? ''}
                      onChange={(e) =>
                        setProfile({ ...profile, location: optionalText(e.target.value) })
                      }
                    />
                  </label>
                </div>
              </div>
            </section>

            <section className="detail__panel">
              <PanelHead id="section-links" legend="Links" />
              <div className="detail__panel-body">
                <div className="profile-field-grid">
                  <label className="profile-field">
                    LinkedIn
                    <input
                      className="search"
                      type="url"
                      autoComplete="url"
                      value={profile.links.linkedin ?? ''}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          links: { ...profile.links, linkedin: optionalText(e.target.value) },
                        })
                      }
                    />
                  </label>
                  <label className="profile-field">
                    Portfolio
                    <input
                      className="search"
                      type="url"
                      autoComplete="url"
                      value={profile.links.portfolio ?? ''}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          links: { ...profile.links, portfolio: optionalText(e.target.value) },
                        })
                      }
                    />
                  </label>
                  <label className="profile-field profile-field--span-2">
                    GitHub
                    <input
                      className="search"
                      type="url"
                      autoComplete="url"
                      value={profile.links.github ?? ''}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          links: { ...profile.links, github: optionalText(e.target.value) },
                        })
                      }
                    />
                  </label>
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
                <label className="profile-field profile-field--span-2">
                  Summary
                  <textarea
                    value={profile.summary ?? ''}
                    onChange={(e) =>
                      setProfile({ ...profile, summary: optionalText(e.target.value) })
                    }
                  />
                </label>
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
                  <label className="profile-field">
                    Page size
                    <select
                      className="search"
                      value={profile.resumePageSize}
                      onChange={(event) =>
                        setProfile({
                          ...profile,
                          resumePageSize: event.currentTarget.value as Profile['resumePageSize'],
                        })
                      }
                    >
                      <option value="A4">A4</option>
                      <option value="LETTER">Letter</option>
                    </select>
                  </label>
                  <label className="profile-checkbox-field">
                    <input
                      type="checkbox"
                      checked={profile.showRolePrefix}
                      onChange={(event) =>
                        setProfile({ ...profile, showRolePrefix: event.currentTarget.checked })
                      }
                    />
                    Prefix titles with “Role:”
                  </label>
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
              {(entry, index) => {
                const n = index + 1;
                return (
                  <div className="profile-field-grid">
                    <label className="profile-field">
                      {`Company ${n}`}
                      <input
                        className="search"
                        value={entry.company}
                        onChange={(e) => work.update(index, { company: e.target.value })}
                      />
                    </label>
                    <label className="profile-field">
                      {`Title ${n}`}
                      <input
                        className="search"
                        value={entry.title}
                        onChange={(e) => work.update(index, { title: e.target.value })}
                      />
                    </label>
                    <label className="profile-field">
                      {`Start date ${n}`}
                      <input
                        className="search"
                        value={entry.startDate}
                        onChange={(e) => work.update(index, { startDate: e.target.value })}
                      />
                    </label>
                    <label className="profile-field">
                      {`End date ${n}`}
                      <input
                        className="search"
                        value={entry.endDate ?? ''}
                        onChange={(e) =>
                          work.update(index, { endDate: optionalText(e.target.value) })
                        }
                      />
                    </label>
                    <label className="profile-field">
                      {`Bullet cap ${n}`}
                      <input
                        className="search"
                        type="number"
                        min="0"
                        step="1"
                        placeholder={`Inherit ${profile.maxBulletsPerRole}`}
                        value={entry.maxBullets ?? ''}
                        onChange={(event) => {
                          const cap = parseBulletCap(
                            event.currentTarget.value,
                            event.currentTarget.valueAsNumber,
                          );
                          if (cap !== undefined) work.update(index, { maxBullets: cap });
                        }}
                      />
                    </label>
                    <label className="profile-checkbox-field">
                      <input
                        type="checkbox"
                        checked={entry.suppressIfEmpty}
                        onChange={(event) =>
                          work.update(index, { suppressIfEmpty: event.currentTarget.checked })
                        }
                      />
                      {`Hide role ${n} entirely if tailoring selects no bullets for it`}
                    </label>
                    <div className="profile-field profile-field--span-2">
                      {`Bullets ${n}`}
                      <div className="profile-bullets">
                        {entry.bullets.map((bullet, bulletIndex) => (
                          <div key={bulletIndex} className="profile-bullet-row">
                            <button
                              type="button"
                              className="profile-star"
                              aria-label={`${entry.starredIndices.includes(bulletIndex) ? 'Unstar' : 'Star'} bullet ${n}.${bulletIndex + 1}`}
                              aria-pressed={entry.starredIndices.includes(bulletIndex)}
                              onClick={() =>
                                work.update(index, toggleStarredBullet(entry, bulletIndex))
                              }
                            >
                              <span aria-hidden="true">
                                {entry.starredIndices.includes(bulletIndex) ? '★' : '☆'}
                              </span>
                            </button>
                            <input
                              className="search"
                              aria-label={`Bullet ${n}.${bulletIndex + 1}`}
                              value={bullet}
                              onChange={(e) =>
                                work.update(
                                  index,
                                  spliceWorkBullets(entry, bulletIndex, 1, e.target.value),
                                )
                              }
                            />
                            <button
                              type="button"
                              className="button profile-remove"
                              aria-label={`Remove bullet ${n}.${bulletIndex + 1}`}
                              onClick={() =>
                                work.update(index, spliceWorkBullets(entry, bulletIndex, 1))
                              }
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                      <button
                        type="button"
                        className="button"
                        onClick={() =>
                          work.update(index, spliceWorkBullets(entry, entry.bullets.length, 0, ''))
                        }
                      >
                        + Add bullet
                      </button>
                    </div>
                  </div>
                );
              }}
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
              {(entry, index) => {
                const n = index + 1;
                return (
                  <div className="profile-field-grid">
                    <label className="profile-field">
                      {`Name ${n}`}
                      <input
                        className="search"
                        value={entry.name}
                        onChange={(e) => projects.update(index, { name: e.target.value })}
                      />
                    </label>
                    <label className="profile-field">
                      {`Link ${n}`}
                      <input
                        className="search"
                        type="url"
                        value={entry.link ?? ''}
                        onChange={(e) =>
                          projects.update(index, { link: optionalText(e.target.value) })
                        }
                      />
                    </label>
                    <label className="profile-field profile-field--span-2">
                      {`Description ${n}`}
                      <textarea
                        value={entry.description}
                        onChange={(e) => projects.update(index, { description: e.target.value })}
                      />
                    </label>
                    <label className="profile-field profile-field--span-2">
                      {`Technologies ${n}`}
                      <input
                        className="search"
                        placeholder="Comma-separated"
                        value={(entry.technologies ?? []).join(', ')}
                        onChange={(e) =>
                          projects.update(index, { technologies: optionalList(e.target.value) })
                        }
                      />
                    </label>
                    <div className="profile-field profile-field--span-2">
                      {`Bullets ${n}`}
                      <div className="profile-bullets">
                        {entry.bullets.map((bullet, bulletIndex) => (
                          <div key={bulletIndex} className="profile-bullet-row">
                            <input
                              className="search"
                              aria-label={`Project ${n} bullet ${bulletIndex + 1}`}
                              value={bullet}
                              onChange={(e) =>
                                projects.update(
                                  index,
                                  spliceProjectBullets(entry, bulletIndex, 1, e.target.value),
                                )
                              }
                            />
                            <button
                              type="button"
                              className="button profile-remove"
                              aria-label={`Remove project ${n} bullet ${bulletIndex + 1}`}
                              onClick={() =>
                                projects.update(index, spliceProjectBullets(entry, bulletIndex, 1))
                              }
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                      <button
                        type="button"
                        className="button"
                        onClick={() =>
                          projects.update(
                            index,
                            spliceProjectBullets(entry, entry.bullets.length, 0, ''),
                          )
                        }
                      >
                        + Add bullet
                      </button>
                    </div>
                  </div>
                );
              }}
            </ListSection>

            <ListSection
              id="section-education"
              legend="Education"
              noun="education"
              addLabel="Add education"
              items={profile.education}
              editor={education}
            >
              {(entry, index) => {
                const n = index + 1;
                return (
                  <div className="profile-field-grid">
                    <label className="profile-field">
                      {`School ${n}`}
                      <input
                        className="search"
                        value={entry.school}
                        onChange={(e) => education.update(index, { school: e.target.value })}
                      />
                    </label>
                    <label className="profile-field">
                      {`Degree ${n}`}
                      <input
                        className="search"
                        value={entry.degree}
                        onChange={(e) => education.update(index, { degree: e.target.value })}
                      />
                    </label>
                    <label className="profile-field">
                      {`Field ${n}`}
                      <input
                        className="search"
                        value={entry.field ?? ''}
                        onChange={(e) =>
                          education.update(index, { field: optionalText(e.target.value) })
                        }
                      />
                    </label>
                    <label className="profile-field">
                      {`Graduation year ${n}`}
                      <input
                        className="search"
                        value={entry.graduationYear ?? ''}
                        onChange={(e) =>
                          education.update(index, { graduationYear: optionalText(e.target.value) })
                        }
                      />
                    </label>
                  </div>
                );
              }}
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
              {(item, index) => {
                const n = index + 1;
                return (
                  <div className="profile-field-grid">
                    <label className="profile-field">
                      {`Type ${n}`}
                      <select
                        className="search"
                        value={item.kind}
                        onChange={(e) =>
                          credentials.changeKind(
                            item,
                            e.currentTarget.value as CredentialItem['kind'],
                          )
                        }
                      >
                        <option value="certification">Certification</option>
                        <option value="award">Award</option>
                      </select>
                    </label>
                    <label className="profile-field">
                      {`Name ${n}`}
                      <input
                        className="search"
                        value={item.name}
                        onChange={(e) => credentials.editor.update(index, { name: e.target.value })}
                      />
                    </label>
                    <label className="profile-field">
                      {`Issuer ${n}`}
                      <input
                        className="search"
                        value={item.issuer}
                        onChange={(e) =>
                          credentials.editor.update(index, { issuer: e.target.value })
                        }
                      />
                    </label>
                    <label className="profile-field">
                      {`Date ${n}`}
                      <input
                        className="search"
                        value={item.date}
                        onChange={(e) => credentials.editor.update(index, { date: e.target.value })}
                      />
                    </label>
                    {item.kind === 'award' && (
                      <label className="profile-field profile-field--span-2">
                        {`Description ${n}`}
                        <textarea
                          value={item.description ?? ''}
                          onChange={(e) =>
                            credentials.editor.update(index, {
                              description: optionalText(e.target.value) ?? undefined,
                            })
                          }
                        />
                      </label>
                    )}
                  </div>
                );
              }}
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
                  {SCREENING_TOPICS.map((entry) => (
                    <label className="profile-field" key={entry.topic}>
                      {entry.label}
                      <input
                        className="search"
                        list={`${entry.topic}-suggestions`}
                        value={profile.screeningAnswers[entry.topic] ?? ''}
                        onChange={(e) =>
                          setProfile({
                            ...profile,
                            screeningAnswers: withScreeningAnswer(
                              profile.screeningAnswers,
                              entry.topic,
                              e.target.value,
                            ),
                          })
                        }
                      />
                      <datalist id={`${entry.topic}-suggestions`}>
                        {entry.suggestions.map((suggestion) => (
                          <option key={suggestion} value={suggestion} />
                        ))}
                      </datalist>
                    </label>
                  ))}
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
                  <label className="profile-field">
                    Question
                    <input
                      className="search"
                      value={entry.question}
                      onChange={(e) => customAnswers.update(index, { question: e.target.value })}
                    />
                  </label>
                  <label className="profile-field">
                    Answer
                    <textarea
                      value={entry.answer}
                      onChange={(e) => customAnswers.update(index, { answer: e.target.value })}
                    />
                  </label>
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
              {(entry, index) => {
                const n = index + 1;
                return (
                  <div className="profile-field-grid">
                    <label className="profile-field">
                      {`Story id ${n}`}
                      <input
                        className="search"
                        value={entry.id}
                        onChange={(e) => stories.update(index, { id: e.target.value })}
                      />
                    </label>
                    <label className="profile-field">
                      {`Story title ${n}`}
                      <input
                        className="search"
                        value={entry.title}
                        onChange={(e) => stories.update(index, { title: e.target.value })}
                      />
                    </label>
                    <label className="profile-field profile-field--span-2">
                      {`Story tags ${n}`}
                      <input
                        className="search"
                        value={entry.tags.join(', ')}
                        onChange={(e) => stories.update(index, { tags: commaList(e.target.value) })}
                      />
                    </label>
                    <label className="profile-field profile-field--span-2">
                      {`Situation ${n}`}
                      <textarea
                        value={entry.situation}
                        onChange={(e) => stories.update(index, { situation: e.target.value })}
                      />
                    </label>
                    <label className="profile-field profile-field--span-2">
                      {`Task ${n}`}
                      <textarea
                        value={entry.task}
                        onChange={(e) => stories.update(index, { task: e.target.value })}
                      />
                    </label>
                    <label className="profile-field profile-field--span-2">
                      {`Action ${n}`}
                      <textarea
                        value={entry.action}
                        onChange={(e) => stories.update(index, { action: e.target.value })}
                      />
                    </label>
                    <label className="profile-field profile-field--span-2">
                      {`Result ${n}`}
                      <textarea
                        value={entry.result}
                        onChange={(e) => stories.update(index, { result: e.target.value })}
                      />
                    </label>
                  </div>
                );
              }}
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
