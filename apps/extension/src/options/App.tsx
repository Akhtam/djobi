/** Options page root — profile onboarding form (`PROGRESS.md` Phase 5). */
import {
  EMPTY_PROFILE,
  parseProfile,
  SCREENING_TOPICS,
  type Profile,
  type ScreeningAnswers,
  type ScreeningTopic,
} from '@djobi/shared';
import { useEffect, useState } from 'react';
import './App.css';
import icon48 from '../assets/icons/icon48.png';
import { callBackend } from '../lib/callBackend';
import { ThemeToggle, useThemePreference } from '../lib/theme';

/**
 * Sets one screening topic's answer, dropping the key entirely when cleared. An empty string would
 * otherwise read as "answered, with nothing" — and `preparedAnswerFor` would have to special-case
 * it — where the absence of a key already means the unambiguous thing: not answered.
 */
function withScreeningAnswer(
  answers: ScreeningAnswers,
  topic: ScreeningTopic,
  value: string,
): ScreeningAnswers {
  if (!value.trim()) {
    const { [topic]: _removed, ...rest } = answers;
    return rest;
  }
  return { ...answers, [topic]: value };
}

/**
 * A cleared optional field, as `null` rather than `''`.
 *
 * The Profile's optional scalars — `phone`, `location`, every `links` entry, an education's `field`
 * and `graduationYear`, a role's `endDate` — are typed `string | null`, and `null` is what the rest
 * of the system reads as "not provided". Binding an input straight to `e.target.value` wrote `''`
 * into all of them instead, so a field the candidate cleared came back as present-but-empty and had
 * to be treated as absent by everything downstream that cared.
 *
 * This is the same rule {@link withScreeningAnswer} applies to screening answers, which stated it
 * first and stated it alone: one module held two contradictory ideas of what empty means.
 */
function orNull(value: string): string | null {
  return value.trim() ? value : null;
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
  legend,
  noun,
  addLabel,
  hint,
  items,
  editor,
  children,
}: {
  legend: string;
  noun: string;
  addLabel: string;
  hint?: string;
  items: T[];
  editor: ListEditor<T>;
  children: (entry: T, index: number) => React.ReactNode;
}) {
  return (
    <fieldset className="card">
      <legend>{legend}</legend>
      <div className="section-meta">
        {hint ? <p className="hint">{hint}</p> : <span />}
        <span className="entry-count">{items.length}</span>
      </div>
      {items.length === 0 && <p className="empty-list">No {noun} added yet.</p>}
      {items.map((entry, index) => (
        <fieldset key={index} className="entry-card">
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
        </fieldset>
      ))}
      <button type="button" className="btn-add" onClick={editor.add}>
        {addLabel}
      </button>
    </fieldset>
  );
}

export function App() {
  const { theme, toggleTheme } = useThemePreference();
  const [profile, setProfileState] = useState<Profile | null>(null);
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; message: string } | null>(null);
  const [newSkill, setNewSkill] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  function setProfile(next: Profile) {
    setProfileState(next);
    setDirty(true);
    if (status?.kind === 'saved') setStatus(null);
  }

  useEffect(() => {
    callBackend<Profile | null>('/profile', undefined, 'GET')
      // `parseProfile` completes a stored profile against the empty one and validates it, so a
      // profile saved before a field existed can't crash the form that binds to that key.
      .then((loaded) => setProfileState(parseProfile(loaded)))
      .catch((error: Error) => {
        setProfileState(EMPTY_PROFILE);
        setStatus({ kind: 'error', message: `Failed to load profile: ${error.message}` });
      });
  }, []);

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
  }));
  const education = listEditor(profile, setProfile, 'education', () => ({
    school: '',
    degree: '',
    field: null,
    graduationYear: null,
  }));
  // `id: ''` matches what this form has always created. Note `QuestionAnswer.sourceStoryIds`
  // references `Story.id`, so every story sharing the empty id makes those references useless —
  // worth fixing, but it is a behaviour change rather than part of this de-duplication.
  const stories = listEditor(profile, setProfile, 'stories', () => ({
    id: '',
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
    const toSave: Profile = {
      ...profile,
      workExperience: profile.workExperience.map((we) => ({
        ...we,
        bullets: we.bullets.filter((bullet) => bullet.trim() !== ''),
      })),
    };
    callBackend<Profile>('/profile', toSave)
      .then((saved) => {
        setProfileState(parseProfile(saved));
        setDirty(false);
        setStatus({ kind: 'saved', message: 'Profile saved.' });
      })
      .catch((error: Error) => setStatus({ kind: 'error', message: error.message }))
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
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
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
      <form onSubmit={handleSave}>
        <section className="card contact-card" aria-labelledby="contact-title">
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
                onChange={(e) => setProfile({ ...profile, phone: orNull(e.target.value) })}
              />
            </div>

            <div className="field">
              <label htmlFor="location">Location</label>
              <input
                id="location"
                autoComplete="address-level2"
                value={profile.location ?? ''}
                onChange={(e) => setProfile({ ...profile, location: orNull(e.target.value) })}
              />
            </div>
          </div>
        </section>

        <fieldset className="card">
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
                    links: { ...profile.links, linkedin: orNull(e.target.value) },
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
                    links: { ...profile.links, portfolio: orNull(e.target.value) },
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
                    links: { ...profile.links, github: orNull(e.target.value) },
                  })
                }
              />
            </div>
          </div>
        </fieldset>

        <fieldset className="card">
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
          legend="Work experience"
          noun="work experience"
          addLabel="Add work experience"
          items={profile.workExperience}
          editor={work}
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
                    onChange={(e) => work.update(index, { endDate: orNull(e.target.value) })}
                  />
                </div>

                <div className="field span-2">
                  <label>{`Bullets ${n}`}</label>
                  <div className="bullet-list">
                    {entry.bullets.map((bullet, bulletIndex) => (
                      <div key={bulletIndex} className="bullet-row">
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
                          aria-label={`Remove bullet ${n}.${bulletIndex + 1}`}
                          onClick={() =>
                            work.update(index, {
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
                    className="btn-add-inline"
                    onClick={() => work.update(index, { bullets: [...entry.bullets, ''] })}
                  >
                    + Add bullet
                  </button>
                </div>
              </div>
            );
          }}
        </ListSection>

        <ListSection
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
                    onChange={(e) => education.update(index, { field: orNull(e.target.value) })}
                  />
                </div>

                <div className="field">
                  <label htmlFor={`eduGradYear${n}`}>{`Graduation year ${n}`}</label>
                  <input
                    id={`eduGradYear${n}`}
                    value={entry.graduationYear ?? ''}
                    onChange={(e) =>
                      education.update(index, { graduationYear: orNull(e.target.value) })
                    }
                  />
                </div>
              </div>
            );
          }}
        </ListSection>

        {/* Facts, not prose. Anything answered here is filled straight from the profile and never
            reaches the answer-drafting model — see `@djobi/shared`'s `screeningAnswers.ts`. */}
        <fieldset className="card screening-card">
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
                        tags: e.target.value
                          .split(',')
                          .map((tag) => tag.trim())
                          .filter(Boolean),
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
