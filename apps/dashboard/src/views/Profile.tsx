/**
 * The account-profile editor — `#/profile`, reachable from the header's account menu.
 *
 * The same Profile the extension's options page edits (`apps/extension/src/options/App.tsx`), and
 * deliberately built the same way: the list-editing helpers (`listEditor`, `ListSection`) and the
 * draft-normalization helpers they call into (`normalizeProfileDraft`, `spliceWorkBullets`, …) are
 * shared with that page via `@djobi/shared`'s `profileDraft.ts` rather than re-implemented here, so
 * "star a bullet" or "drop a blank story id" behaves identically in both places. Only the chrome
 * around the form — the panel/card shell, the save affordance, how a 401 is reported — is
 * dashboard-specific, matching `Analytics.tsx`'s `onUnauthorized` convention rather than the
 * extension's own `unauthorized`-state-and-`<Login>` one, since the dashboard already redirects to
 * `#/login` centrally in `App.tsx`.
 */
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import { HttpError } from '@djobi/http-client';
import {
  applyExtractedProfile,
  EMPTY_PROFILE,
  failureMessage,
  normalizeProfileDraft,
  optionalText,
  parseProfile,
  SCREENING_TOPICS,
  spliceWorkBullets,
  storyTags,
  withScreeningAnswer,
  type Award,
  type Certification,
  type ExtractedProfile,
  type Profile,
} from '@djobi/shared';

function isUnauthorized(error: unknown): boolean {
  return error instanceof HttpError && error.kind === 'http' && error.status === 401;
}

/** The Profile keys holding an editable list of entries. */
type ProfileListKey =
  | 'workExperience'
  | 'education'
  | 'projects'
  | 'certifications'
  | 'awards'
  | 'stories'
  | 'customAnswers';

/**
 * One row of the combined Certifications & Awards section — see the identical type in the
 * extension's options page (`apps/extension/src/options/App.tsx`) for why it's flat rather than a
 * discriminated union of {@link Certification}/{@link Award}.
 */
interface CredentialItem {
  kind: 'certification' | 'award';
  index: number;
  name: string;
  issuer: string;
  date: string;
  description?: string;
}

/** Certifications, then awards, each tagged with where it lives — see {@link CredentialItem}. */
function credentialItems(profile: Profile): CredentialItem[] {
  return [
    ...profile.certifications.map((entry, index) => ({
      kind: 'certification' as const,
      index,
      ...entry,
    })),
    ...profile.awards.map((entry, index) => ({ kind: 'award' as const, index, ...entry })),
  ];
}

/** The three things every list section does to its list. Bound to one key by {@link listEditor}. */
interface ListEditor<T> {
  update: (index: number, patch: Partial<T>) => void;
  remove: (index: number) => void;
  add: () => void;
}

/** The list operations for one Profile key — see the identical helper in the extension's options page. */
function listEditor<K extends ProfileListKey>(
  profile: Profile,
  setProfile: (profile: Profile) => void,
  key: K,
  blank: () => Profile[K][number],
): ListEditor<Profile[K][number]> {
  const list = profile[key] as Profile[K][number][];

  const write = (next: Profile[K][number][]) => setProfile({ ...profile, [key]: next });

  return {
    update: (index, patch) =>
      write(list.map((entry, i) => (i === index ? { ...entry, ...patch } : entry))),
    remove: (index) => write(list.filter((_, i) => i !== index)),
    add: () => write([...list, blank()]),
  };
}

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

/** Sections, in the order the quick-nav and the form itself present them, tagged by owning tab. */
const PANEL_ORDER = [
  { anchor: 'section-contact', label: 'Contact', tab: 'profile' },
  { anchor: 'section-links', label: 'Links', tab: 'profile' },
  { anchor: 'section-summary', label: 'Summary', tab: 'profile' },
  { anchor: 'section-resume', label: 'Resume', tab: 'profile' },
  { anchor: 'section-skills', label: 'Skills', tab: 'profile' },
  { anchor: 'section-work', label: 'Work', tab: 'profile' },
  { anchor: 'section-projects', label: 'Projects', tab: 'profile' },
  { anchor: 'section-education', label: 'Education', tab: 'profile' },
  { anchor: 'section-credentials', label: 'Credentials', tab: 'profile' },
  { anchor: 'section-screening', label: 'Screening', tab: 'prep' },
  { anchor: 'section-answers', label: 'Answers', tab: 'prep' },
  { anchor: 'section-stories', label: 'Stories', tab: 'prep' },
] as const satisfies readonly { anchor: string; label: string; tab: ProfileTab }[];

/**
 * Scrolls to a section by id without touching `location.hash` — a plain `<a href="#section-x">`
 * would fire `hashchange`, and `useHashRoute` (`App.tsx`) treats any hash it doesn't recognise as
 * the applications list, bouncing the user off the profile page entirely.
 */
function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

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
  const [profile, setProfileState] = useState<Profile | null>(null);
  const [activeTab, setActiveTab] = useState<ProfileTab>('profile');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; message: string } | null>(null);
  const [newSkill, setNewSkill] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [extracting, setExtracting] = useState(false);
  // Separate from `status` above: that means "the save you just asked for landed or didn't," and
  // an extraction is neither — nothing is saved until the candidate reviews the pre-filled fields
  // and clicks Save themselves.
  const [extraction, setExtraction] = useState<{
    kind: 'notice' | 'error';
    message: string;
  } | null>(null);
  const editRevisionRef = useRef(0);
  // The upload button opens the file picker by proxy — the real `<input type="file">` is visually
  // hidden so this can be a normal styled button rather than the browser's own file-input chrome.
  const resumeInputRef = useRef<HTMLInputElement>(null);

  function setProfile(next: Profile) {
    ++editRevisionRef.current;
    setProfileState(next);
    setDirty(true);
    if (status?.kind === 'saved') setStatus(null);
  }

  useEffect(() => {
    let current = true;
    getProfile().then(
      (loaded) => {
        if (!current) return;
        setProfileState(parseProfile(loaded));
      },
      (error: unknown) => {
        if (!current) return;
        if (isUnauthorized(error)) {
          onUnauthorized();
          return;
        }
        setProfileState(EMPTY_PROFILE);
        setLoadError(failureMessage(error));
      },
    );
    return () => {
      current = false;
    };
  }, [getProfile, onUnauthorized]);

  if (!profile) {
    return <p className="empty-state">Loading profile…</p>;
  }

  const work = listEditor(profile, setProfile, 'workExperience', () => ({
    company: '',
    title: '',
    startDate: '',
    endDate: null,
    bullets: [],
    maxBullets: null,
    starredIndices: [],
    suppressIfEmpty: false,
  }));
  const education = listEditor(profile, setProfile, 'education', () => ({
    school: '',
    degree: '',
    field: null,
    graduationYear: null,
  }));
  const stories = listEditor(profile, setProfile, 'stories', () => ({
    id: crypto.randomUUID(),
    title: '',
    tags: [],
    situation: '',
    task: '',
    action: '',
    result: '',
  }));
  const customAnswers = listEditor(profile, setProfile, 'customAnswers', () => ({
    question: '',
    answer: '',
  }));
  const projects = listEditor(profile, setProfile, 'projects', () => ({
    name: '',
    description: '',
    bullets: [],
    link: null,
    technologies: null,
  }));
  const certifications = listEditor(profile, setProfile, 'certifications', () => ({
    name: '',
    issuer: '',
    date: '',
  }));
  const awards = listEditor(profile, setProfile, 'awards', () => ({
    name: '',
    issuer: '',
    date: '',
  }));
  const credentials = credentialItems(profile);
  /**
   * The combined section's `editor` — see the identical one in the extension's options page for
   * why `.update` dispatches to whichever of the two real editors above owns the row.
   */
  const credentialsEditor: ListEditor<CredentialItem> = {
    update: (combinedIndex, patch) => {
      const item = credentials[combinedIndex];
      if (item.kind === 'certification') {
        certifications.update(item.index, patch as Partial<Certification>);
      } else {
        awards.update(item.index, patch as Partial<Award>);
      }
    },
    remove: (combinedIndex) => {
      const item = credentials[combinedIndex];
      if (item.kind === 'certification') certifications.remove(item.index);
      else awards.remove(item.index);
    },
    add: () => certifications.add(),
  };
  /** Moves one row between the two arrays — see the identical helper in the extension's options page. */
  function changeCredentialKind(item: CredentialItem, kind: CredentialItem['kind']) {
    if (!profile || item.kind === kind) return;
    const shared = { name: item.name, issuer: item.issuer, date: item.date };
    if (kind === 'award') {
      setProfile({
        ...profile,
        certifications: profile.certifications.filter((_, i) => i !== item.index),
        awards: [...profile.awards, shared],
      });
    } else {
      setProfile({
        ...profile,
        awards: profile.awards.filter((_, i) => i !== item.index),
        certifications: [...profile.certifications, shared],
      });
    }
  }

  /**
   * Parses the uploaded resume and applies whatever it found onto the draft — never saved on its
   * own. `setProfile` marks the form `dirty`, so "You have unsaved changes" already says nothing
   * has been persisted yet; `extraction` here is only the upload's own success/failure message.
   */
  async function handleResumeUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Cleared immediately so re-selecting the same file still fires a change event.
    event.target.value = '';
    if (!file || !profile) return;

    setExtraction(null);
    setExtracting(true);
    try {
      const extracted = await extractResume(file);
      setProfile(applyExtractedProfile(profile, extracted));
      setExtraction({
        kind: 'notice',
        message: 'Resume parsed. Review the pre-filled fields below, then save.',
      });
    } catch (error) {
      if (isUnauthorized(error)) {
        onUnauthorized();
        return;
      }
      setExtraction({
        kind: 'error',
        message: `Couldn't parse this resume: ${failureMessage(error)}`,
      });
    } finally {
      setExtracting(false);
    }
  }

  function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!profile) return;
    setStatus(null);
    setSaving(true);
    const savedRevision = editRevisionRef.current;
    const toSave = normalizeProfileDraft(profile, () => crypto.randomUUID());
    saveProfile(toSave)
      .then((saved) => {
        // The form remains editable while saving — do not replace newer edits with an older response.
        if (savedRevision !== editRevisionRef.current) return;
        setProfileState(parseProfile(saved));
        setDirty(false);
        setStatus({ kind: 'saved', message: 'Profile saved.' });
      })
      .catch((error: unknown) => {
        if (isUnauthorized(error)) {
          onUnauthorized();
          return;
        }
        setStatus({ kind: 'error', message: failureMessage(error) });
      })
      .finally(() => setSaving(false));
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
          {PANEL_ORDER.filter((panel) => panel.tab === activeTab).map((panel) => (
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
                        onClick={() =>
                          setProfile({
                            ...profile,
                            skills: profile.skills.filter((s) => s !== skill),
                          })
                        }
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
                      if (!newSkill) return;
                      setProfile({ ...profile, skills: [...profile.skills, newSkill] });
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
                          const raw = event.currentTarget.value;
                          const value = event.currentTarget.valueAsNumber;
                          if (!raw) work.update(index, { maxBullets: null });
                          else if (Number.isInteger(value) && value >= 0) {
                            work.update(index, { maxBullets: value });
                          }
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
                              onClick={() => {
                                const isStarred = entry.starredIndices.includes(bulletIndex);
                                work.update(index, {
                                  starredIndices: isStarred
                                    ? entry.starredIndices.filter((star) => star !== bulletIndex)
                                    : [...entry.starredIndices, bulletIndex].sort((a, b) => a - b),
                                });
                              }}
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
                                work.update(index, {
                                  bullets: entry.bullets.map((b, bi) =>
                                    bi === bulletIndex ? e.target.value : b,
                                  ),
                                })
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
                        onChange={(e) => {
                          const technologies = e.target.value
                            .split(',')
                            .map((tech) => tech.trim())
                            .filter(Boolean);
                          projects.update(index, {
                            technologies: technologies.length ? technologies : null,
                          });
                        }}
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
                                projects.update(index, {
                                  bullets: entry.bullets.map((b, bi) =>
                                    bi === bulletIndex ? e.target.value : b,
                                  ),
                                })
                              }
                            />
                            <button
                              type="button"
                              className="button profile-remove"
                              aria-label={`Remove project ${n} bullet ${bulletIndex + 1}`}
                              onClick={() =>
                                projects.update(index, {
                                  bullets: entry.bullets.filter((_, bi) => bi !== bulletIndex),
                                })
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
                        onClick={() => projects.update(index, { bullets: [...entry.bullets, ''] })}
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
              items={credentials}
              editor={credentialsEditor}
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
                          changeCredentialKind(
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
                        onChange={(e) => credentialsEditor.update(index, { name: e.target.value })}
                      />
                    </label>
                    <label className="profile-field">
                      {`Issuer ${n}`}
                      <input
                        className="search"
                        value={item.issuer}
                        onChange={(e) =>
                          credentialsEditor.update(index, { issuer: e.target.value })
                        }
                      />
                    </label>
                    <label className="profile-field">
                      {`Date ${n}`}
                      <input
                        className="search"
                        value={item.date}
                        onChange={(e) => credentialsEditor.update(index, { date: e.target.value })}
                      />
                    </label>
                    {item.kind === 'award' && (
                      <label className="profile-field profile-field--span-2">
                        {`Description ${n}`}
                        <textarea
                          value={item.description ?? ''}
                          onChange={(e) =>
                            credentialsEditor.update(index, {
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
                        onChange={(e) => stories.update(index, { tags: storyTags(e.target.value) })}
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
          <button type="submit" className="button button--primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save profile'}
          </button>
        </div>
      </form>
    </article>
  );
}
