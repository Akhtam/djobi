/**
 * Options page root — the profile onboarding form, and the only surface that edits a Profile.
 *
 * `client` is a prop for the same reason it is one in `panel/App.tsx`: the page is tested through
 * a fake adapter at the backend seam, and `options/main.tsx` is the only place the real one is
 * named.
 */
import {
  EMPTY_PROFILE,
  normalizeProfileDraft,
  optionalText,
  parseProfile,
  SCREENING_TOPICS,
  spliceWorkBullets,
  storyTags,
  withScreeningAnswer,
  type Profile,
} from '@djobi/shared';
import { useEffect, useRef, useState } from 'react';
import './App.css';
import icon48 from '../assets/icons/icon48.png';
import type { BackendClient } from '../lib/backendClient';
import { HttpError } from '../lib/callBackend';
import { ThemeToggle, useThemePreference } from '../lib/theme';
import { Login } from './Login';

/** `err` is an `HttpError` reporting the backend's own 401 — an absent or expired session. */
function isUnauthorized(err: unknown): boolean {
  return err instanceof HttpError && err.kind === 'http' && err.status === 401;
}

/** The Profile keys holding an editable list of entries. */
type ProfileListKey = 'workExperience' | 'education' | 'stories' | 'customAnswers';

/** The three things every list section does to its list. Bound to one key by {@link listEditor}. */
interface ListEditor<T> {
  /** Merges `patch` into entry `index`, leaving the others alone. */
  update: (index: number, patch: Partial<T>) => void;
  remove: (index: number) => void;
  add: () => void;
}

/**
 * The list operations for one Profile key.
 *
 * The four list sections used to write these inline, once per editable field — around twenty copies
 * of `setProfile({ ...profile, xs: profile.xs.map((x, i) => i === index ? { ...x, k: v } : x) })`,
 * one of them nested three levels deep for a work-experience bullet. They are the same three
 * operations every time, and spelling them out at each input meant the shape of a Profile update
 * was restated at every input rather than being stated once.
 */
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

/** Sections, in the order the quick-nav and the form itself present them. */
const PANEL_ORDER = [
  { anchor: 'section-contact', label: 'Contact' },
  { anchor: 'section-links', label: 'Links' },
  { anchor: 'section-resume', label: 'Resume' },
  { anchor: 'section-skills', label: 'Skills' },
  { anchor: 'section-work', label: 'Work' },
  { anchor: 'section-education', label: 'Education' },
  { anchor: 'section-screening', label: 'Screening' },
  { anchor: 'section-answers', label: 'Answers' },
  { anchor: 'section-stories', label: 'Stories' },
] as const;

/**
 * Scrolls to a section by id without touching `location.hash` — this page has no router to
 * confuse, but a plain in-page click shouldn't add a history entry either.
 */
function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function App({ client }: { client: BackendClient }) {
  const { theme, toggleTheme } = useThemePreference();
  const [profile, setProfileState] = useState<Profile | null>(null);
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; message: string } | null>(null);
  const [newSkill, setNewSkill] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const editRevisionRef = useRef(0);
  // Set on a 401 from `getProfile` rather than surfaced through `status` — an absent or expired
  // session is "go sign in again," not "the backend is broken," and this is what routes to `Login`
  // below instead of a generic error banner over an unusable empty form.
  const [unauthorized, setUnauthorized] = useState(false);
  // Bumped by `handleSignIn` to force the fetch effect below to run again once a fresh sign-in has
  // replaced the session that expired.
  const [reloadToken, setReloadToken] = useState(0);

  function setProfile(next: Profile) {
    ++editRevisionRef.current;
    setProfileState(next);
    setDirty(true);
    if (status?.kind === 'saved') setStatus(null);
  }

  useEffect(() => {
    client
      .getProfile()
      // `parseProfile` completes a stored profile against the empty one and validates it, so a
      // profile saved before a field existed can't crash the form that binds to that key.
      .then((loaded) => {
        setUnauthorized(false);
        setProfileState(parseProfile(loaded));
      })
      .catch((error: unknown) => {
        if (isUnauthorized(error)) {
          setUnauthorized(true);
          return;
        }
        setProfileState(EMPTY_PROFILE);
        const message = error instanceof Error ? error.message : String(error);
        setStatus({ kind: 'error', message: `Failed to load profile: ${message}` });
      });
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
    // Answer provenance stores Story ids, so every new entry needs a stable unique value even when
    // the candidate leaves the editable id field alone.
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

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!profile) return;
    setStatus(null);
    setSaving(true);
    const savedRevision = editRevisionRef.current;
    const toSave = normalizeProfileDraft(profile, () => crypto.randomUUID());
    client
      .saveProfile(toSave)
      .then((saved) => {
        // The form remains editable while saving. Do not replace newer edits with the snapshot
        // returned for an older request.
        if (savedRevision !== editRevisionRef.current) return;
        setProfileState(parseProfile(saved));
        setDirty(false);
        setStatus({ kind: 'saved', message: 'Profile saved.' });
      })
      .catch((error: unknown) => {
        if (isUnauthorized(error)) {
          setUnauthorized(true);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setStatus({ kind: 'error', message });
      })
      .finally(() => setSaving(false));
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
        {PANEL_ORDER.map((panel) => (
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
        <section id="section-contact" className="card contact-card" aria-labelledby="contact-title">
          <div className="card-heading">
            <div>
              <p className="eyebrow">Essentials</p>
              <h3 id="contact-title">Contact details</h3>
            </div>
            <p>Used for form fields and the resume header.</p>
          </div>
          <div className="field-grid">
            <div className="field">
              <label htmlFor="fullName">Full name</label>
              <input
                id="fullName"
                autoComplete="name"
                value={profile.fullName}
                onChange={(e) => setProfile({ ...profile, fullName: e.target.value })}
              />
            </div>

            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={profile.email}
                onChange={(e) => setProfile({ ...profile, email: e.target.value })}
              />
            </div>

            <div className="field">
              <label htmlFor="phone">Phone</label>
              <input
                id="phone"
                type="tel"
                autoComplete="tel"
                value={profile.phone ?? ''}
                onChange={(e) => setProfile({ ...profile, phone: optionalText(e.target.value) })}
              />
            </div>

            <div className="field">
              <label htmlFor="location">Location</label>
              <input
                id="location"
                autoComplete="address-level2"
                value={profile.location ?? ''}
                onChange={(e) => setProfile({ ...profile, location: optionalText(e.target.value) })}
              />
            </div>
          </div>
        </section>

        <fieldset id="section-links" className="card">
          <legend>Links</legend>
          <div className="field-grid">
            <div className="field">
              <label htmlFor="linkedin">LinkedIn</label>
              <input
                id="linkedin"
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
            </div>

            <div className="field">
              <label htmlFor="portfolio">Portfolio</label>
              <input
                id="portfolio"
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
            </div>

            <div className="field span-2">
              <label htmlFor="github">GitHub</label>
              <input
                id="github"
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
            </div>
          </div>
        </fieldset>

        <fieldset id="section-resume" className="card">
          <legend>Resume PDF</legend>
          <p className="card-hint">Formatting used for both resume previews and attachments.</p>
          <div className="field-grid">
            <div className="field">
              <label htmlFor="resumePageSize">Page size</label>
              <select
                id="resumePageSize"
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
            </div>
            <label className="checkbox-field" htmlFor="showRolePrefix">
              <input
                id="showRolePrefix"
                type="checkbox"
                checked={profile.showRolePrefix}
                onChange={(event) =>
                  setProfile({ ...profile, showRolePrefix: event.currentTarget.checked })
                }
              />
              Prefix titles with “Role:”
            </label>
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
          <div className="skill-add-row">
            <div className="field">
              <label htmlFor="newSkill">New skill</label>
              <input id="newSkill" value={newSkill} onChange={(e) => setNewSkill(e.target.value)} />
            </div>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                if (!newSkill) return;
                setProfile({ ...profile, skills: [...profile.skills, newSkill] });
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
          {(entry, index) => {
            const n = index + 1;
            return (
              <div className="field-grid">
                <div className="field">
                  <label htmlFor={`weCompany${n}`}>{`Company ${n}`}</label>
                  <input
                    id={`weCompany${n}`}
                    value={entry.company}
                    onChange={(e) => work.update(index, { company: e.target.value })}
                  />
                </div>

                <div className="field">
                  <label htmlFor={`weTitle${n}`}>{`Title ${n}`}</label>
                  <input
                    id={`weTitle${n}`}
                    value={entry.title}
                    onChange={(e) => work.update(index, { title: e.target.value })}
                  />
                </div>

                <div className="field">
                  <label htmlFor={`weStartDate${n}`}>{`Start date ${n}`}</label>
                  <input
                    id={`weStartDate${n}`}
                    value={entry.startDate}
                    onChange={(e) => work.update(index, { startDate: e.target.value })}
                  />
                </div>

                <div className="field">
                  <label htmlFor={`weEndDate${n}`}>{`End date ${n}`}</label>
                  <input
                    id={`weEndDate${n}`}
                    value={entry.endDate ?? ''}
                    onChange={(e) => work.update(index, { endDate: optionalText(e.target.value) })}
                  />
                </div>

                <div className="field">
                  <label htmlFor={`weMaxBullets${n}`}>{`Bullet cap ${n}`}</label>
                  <input
                    id={`weMaxBullets${n}`}
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
                </div>

                <div className="field">
                  <label className="checkbox-field" htmlFor={`weSuppressIfEmpty${n}`}>
                    <input
                      id={`weSuppressIfEmpty${n}`}
                      type="checkbox"
                      checked={entry.suppressIfEmpty}
                      onChange={(event) =>
                        work.update(index, { suppressIfEmpty: event.currentTarget.checked })
                      }
                    />
                    {`Hide role ${n} entirely if tailoring selects no bullets for it`}
                  </label>
                </div>

                <div className="field span-2">
                  <label>{`Bullets ${n}`}</label>
                  <div className="bullet-list">
                    {entry.bullets.map((bullet, bulletIndex) => (
                      <div key={bulletIndex} className="bullet-row">
                        <button
                          type="button"
                          className="btn-star"
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
                          className="btn-remove-bullet"
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
                    className="btn-add-inline"
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
              <div className="field-grid">
                <div className="field">
                  <label htmlFor={`eduSchool${n}`}>{`School ${n}`}</label>
                  <input
                    id={`eduSchool${n}`}
                    value={entry.school}
                    onChange={(e) => education.update(index, { school: e.target.value })}
                  />
                </div>

                <div className="field">
                  <label htmlFor={`eduDegree${n}`}>{`Degree ${n}`}</label>
                  <input
                    id={`eduDegree${n}`}
                    value={entry.degree}
                    onChange={(e) => education.update(index, { degree: e.target.value })}
                  />
                </div>

                <div className="field">
                  <label htmlFor={`eduField${n}`}>{`Field ${n}`}</label>
                  <input
                    id={`eduField${n}`}
                    value={entry.field ?? ''}
                    onChange={(e) =>
                      education.update(index, { field: optionalText(e.target.value) })
                    }
                  />
                </div>

                <div className="field">
                  <label htmlFor={`eduGradYear${n}`}>{`Graduation year ${n}`}</label>
                  <input
                    id={`eduGradYear${n}`}
                    value={entry.graduationYear ?? ''}
                    onChange={(e) =>
                      education.update(index, { graduationYear: optionalText(e.target.value) })
                    }
                  />
                </div>
              </div>
            );
          }}
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
            {SCREENING_TOPICS.map((entry) => (
              <div className="field" key={entry.topic}>
                <label htmlFor={entry.topic}>{entry.label}</label>
                <input
                  id={entry.topic}
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
              </div>
            ))}
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
            <>
              <div className="field">
                <label htmlFor={`customQuestion-${index}`}>Question</label>
                <input
                  id={`customQuestion-${index}`}
                  value={entry.question}
                  onChange={(e) => customAnswers.update(index, { question: e.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor={`customAnswer-${index}`}>Answer</label>
                <textarea
                  id={`customAnswer-${index}`}
                  value={entry.answer}
                  onChange={(e) => customAnswers.update(index, { answer: e.target.value })}
                />
              </div>
            </>
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
              <div className="field-grid">
                <div className="field">
                  <label htmlFor={`storyId${n}`}>{`Story id ${n}`}</label>
                  <input
                    id={`storyId${n}`}
                    value={entry.id}
                    onChange={(e) => stories.update(index, { id: e.target.value })}
                  />
                </div>

                <div className="field">
                  <label htmlFor={`storyTitle${n}`}>{`Story title ${n}`}</label>
                  <input
                    id={`storyTitle${n}`}
                    value={entry.title}
                    onChange={(e) => stories.update(index, { title: e.target.value })}
                  />
                </div>

                <div className="field span-2">
                  <label htmlFor={`storyTags${n}`}>{`Story tags ${n}`}</label>
                  <input
                    id={`storyTags${n}`}
                    value={entry.tags.join(', ')}
                    onChange={(e) =>
                      stories.update(index, {
                        tags: storyTags(e.target.value),
                      })
                    }
                  />
                </div>

                <div className="field span-2">
                  <label htmlFor={`storySituation${n}`}>{`Situation ${n}`}</label>
                  <textarea
                    id={`storySituation${n}`}
                    value={entry.situation}
                    onChange={(e) => stories.update(index, { situation: e.target.value })}
                  />
                </div>

                <div className="field span-2">
                  <label htmlFor={`storyTask${n}`}>{`Task ${n}`}</label>
                  <textarea
                    id={`storyTask${n}`}
                    value={entry.task}
                    onChange={(e) => stories.update(index, { task: e.target.value })}
                  />
                </div>

                <div className="field span-2">
                  <label htmlFor={`storyAction${n}`}>{`Action ${n}`}</label>
                  <textarea
                    id={`storyAction${n}`}
                    value={entry.action}
                    onChange={(e) => stories.update(index, { action: e.target.value })}
                  />
                </div>

                <div className="field span-2">
                  <label htmlFor={`storyResult${n}`}>{`Result ${n}`}</label>
                  <textarea
                    id={`storyResult${n}`}
                    value={entry.result}
                    onChange={(e) => stories.update(index, { result: e.target.value })}
                  />
                </div>
              </div>
            );
          }}
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
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save profile'}
          </button>
        </div>
      </form>
    </main>
  );
}
