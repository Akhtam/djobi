/** Options page root — profile onboarding form (`PROGRESS.md` Phase 5). */
import type { Profile } from '@djobi/shared';
import { useEffect, useState } from 'react';
import './App.css';
import icon48 from '../assets/icons/icon48.png';
import { sendToBackground } from '../lib/sendToBackground';

const EMPTY_PROFILE: Profile = {
  fullName: '',
  email: '',
  phone: null,
  location: null,
  links: { linkedin: null, portfolio: null, github: null },
  summary: null,
  workExperience: [],
  education: [],
  skills: [],
  stories: [],
};

export function App() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; message: string } | null>(null);
  const [newSkill, setNewSkill] = useState('');

  useEffect(() => {
    sendToBackground<Profile | null>('/profile', undefined, 'GET')
      .then((loaded) => {
        setProfile(loaded ?? EMPTY_PROFILE);
      })
      .catch((error: Error) => {
        setProfile(EMPTY_PROFILE);
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

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!profile) return;
    setStatus(null);
    const toSave: Profile = {
      ...profile,
      workExperience: profile.workExperience.map((we) => ({
        ...we,
        bullets: we.bullets.filter((bullet) => bullet.trim() !== ''),
      })),
    };
    sendToBackground<Profile>('/profile', toSave)
      .then(() => setStatus({ kind: 'saved', message: 'Profile saved.' }))
      .catch((error: Error) => setStatus({ kind: 'error', message: error.message }));
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
      </header>
      <form onSubmit={handleSave}>
        <div className="card">
          <div className="field-grid">
            <div className="field">
              <label htmlFor="fullName">Full name</label>
              <input
                id="fullName"
                value={profile.fullName}
                onChange={(e) => setProfile({ ...profile, fullName: e.target.value })}
              />
            </div>

            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                value={profile.email}
                onChange={(e) => setProfile({ ...profile, email: e.target.value })}
              />
            </div>

            <div className="field">
              <label htmlFor="phone">Phone</label>
              <input
                id="phone"
                value={profile.phone ?? ''}
                onChange={(e) => setProfile({ ...profile, phone: e.target.value })}
              />
            </div>

            <div className="field">
              <label htmlFor="location">Location</label>
              <input
                id="location"
                value={profile.location ?? ''}
                onChange={(e) => setProfile({ ...profile, location: e.target.value })}
              />
            </div>

            <div className="field span-2">
              <label htmlFor="summary">Summary</label>
              <textarea
                id="summary"
                value={profile.summary ?? ''}
                onChange={(e) => setProfile({ ...profile, summary: e.target.value })}
              />
            </div>
          </div>
        </div>

        <fieldset className="card">
          <legend>Links</legend>
          <div className="field-grid">
            <div className="field">
              <label htmlFor="linkedin">LinkedIn</label>
              <input
                id="linkedin"
                value={profile.links.linkedin ?? ''}
                onChange={(e) =>
                  setProfile({ ...profile, links: { ...profile.links, linkedin: e.target.value } })
                }
              />
            </div>

            <div className="field">
              <label htmlFor="portfolio">Portfolio</label>
              <input
                id="portfolio"
                value={profile.links.portfolio ?? ''}
                onChange={(e) =>
                  setProfile({ ...profile, links: { ...profile.links, portfolio: e.target.value } })
                }
              />
            </div>

            <div className="field span-2">
              <label htmlFor="github">GitHub</label>
              <input
                id="github"
                value={profile.links.github ?? ''}
                onChange={(e) =>
                  setProfile({ ...profile, links: { ...profile.links, github: e.target.value } })
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

        <fieldset className="card">
          <legend>Work experience</legend>
          {profile.workExperience.map((entry, index) => {
            const n = index + 1;
            return (
              <fieldset key={index} className="entry-card">
                <div className="entry-card-header">
                  <span>{`Entry ${n}`}</span>
                  <button
                    type="button"
                    className="btn-danger-ghost"
                    aria-label={`Remove work experience ${n}`}
                    onClick={() =>
                      setProfile({
                        ...profile,
                        workExperience: profile.workExperience.filter((_, i) => i !== index),
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
                <div className="field-grid">
                  <div className="field">
                    <label htmlFor={`weCompany${n}`}>{`Company ${n}`}</label>
                    <input
                      id={`weCompany${n}`}
                      value={entry.company}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          workExperience: profile.workExperience.map((we, i) =>
                            i === index ? { ...we, company: e.target.value } : we,
                          ),
                        })
                      }
                    />
                  </div>

                  <div className="field">
                    <label htmlFor={`weTitle${n}`}>{`Title ${n}`}</label>
                    <input
                      id={`weTitle${n}`}
                      value={entry.title}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          workExperience: profile.workExperience.map((we, i) =>
                            i === index ? { ...we, title: e.target.value } : we,
                          ),
                        })
                      }
                    />
                  </div>

                  <div className="field">
                    <label htmlFor={`weStartDate${n}`}>{`Start date ${n}`}</label>
                    <input
                      id={`weStartDate${n}`}
                      value={entry.startDate}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          workExperience: profile.workExperience.map((we, i) =>
                            i === index ? { ...we, startDate: e.target.value } : we,
                          ),
                        })
                      }
                    />
                  </div>

                  <div className="field">
                    <label htmlFor={`weEndDate${n}`}>{`End date ${n}`}</label>
                    <input
                      id={`weEndDate${n}`}
                      value={entry.endDate ?? ''}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          workExperience: profile.workExperience.map((we, i) =>
                            i === index ? { ...we, endDate: e.target.value } : we,
                          ),
                        })
                      }
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
                              setProfile({
                                ...profile,
                                workExperience: profile.workExperience.map((we, i) =>
                                  i === index
                                    ? {
                                        ...we,
                                        bullets: we.bullets.map((b, bi) =>
                                          bi === bulletIndex ? e.target.value : b,
                                        ),
                                      }
                                    : we,
                                ),
                              })
                            }
                          />
                          <button
                            type="button"
                            aria-label={`Remove bullet ${n}.${bulletIndex + 1}`}
                            onClick={() =>
                              setProfile({
                                ...profile,
                                workExperience: profile.workExperience.map((we, i) =>
                                  i === index
                                    ? {
                                        ...we,
                                        bullets: we.bullets.filter((_, bi) => bi !== bulletIndex),
                                      }
                                    : we,
                                ),
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
                      onClick={() =>
                        setProfile({
                          ...profile,
                          workExperience: profile.workExperience.map((we, i) =>
                            i === index ? { ...we, bullets: [...we.bullets, ''] } : we,
                          ),
                        })
                      }
                    >
                      + Add bullet
                    </button>
                  </div>
                </div>
              </fieldset>
            );
          })}
          <button
            type="button"
            className="btn-add"
            onClick={() =>
              setProfile({
                ...profile,
                workExperience: [
                  ...profile.workExperience,
                  { company: '', title: '', startDate: '', endDate: null, bullets: [] },
                ],
              })
            }
          >
            Add work experience
          </button>
        </fieldset>

        <fieldset className="card">
          <legend>Education</legend>
          {profile.education.map((entry, index) => {
            const n = index + 1;
            return (
              <fieldset key={index} className="entry-card">
                <div className="entry-card-header">
                  <span>{`Entry ${n}`}</span>
                  <button
                    type="button"
                    className="btn-danger-ghost"
                    aria-label={`Remove education ${n}`}
                    onClick={() =>
                      setProfile({
                        ...profile,
                        education: profile.education.filter((_, i) => i !== index),
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
                <div className="field-grid">
                  <div className="field">
                    <label htmlFor={`eduSchool${n}`}>{`School ${n}`}</label>
                    <input
                      id={`eduSchool${n}`}
                      value={entry.school}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          education: profile.education.map((ed, i) =>
                            i === index ? { ...ed, school: e.target.value } : ed,
                          ),
                        })
                      }
                    />
                  </div>

                  <div className="field">
                    <label htmlFor={`eduDegree${n}`}>{`Degree ${n}`}</label>
                    <input
                      id={`eduDegree${n}`}
                      value={entry.degree}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          education: profile.education.map((ed, i) =>
                            i === index ? { ...ed, degree: e.target.value } : ed,
                          ),
                        })
                      }
                    />
                  </div>

                  <div className="field">
                    <label htmlFor={`eduField${n}`}>{`Field ${n}`}</label>
                    <input
                      id={`eduField${n}`}
                      value={entry.field ?? ''}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          education: profile.education.map((ed, i) =>
                            i === index ? { ...ed, field: e.target.value } : ed,
                          ),
                        })
                      }
                    />
                  </div>

                  <div className="field">
                    <label htmlFor={`eduGradYear${n}`}>{`Graduation year ${n}`}</label>
                    <input
                      id={`eduGradYear${n}`}
                      value={entry.graduationYear ?? ''}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          education: profile.education.map((ed, i) =>
                            i === index ? { ...ed, graduationYear: e.target.value } : ed,
                          ),
                        })
                      }
                    />
                  </div>
                </div>
              </fieldset>
            );
          })}
          <button
            type="button"
            className="btn-add"
            onClick={() =>
              setProfile({
                ...profile,
                education: [
                  ...profile.education,
                  { school: '', degree: '', field: null, graduationYear: null },
                ],
              })
            }
          >
            Add education
          </button>
        </fieldset>

        <fieldset className="card">
          <legend>Stories</legend>
          {profile.stories.map((entry, index) => {
            const n = index + 1;
            return (
              <fieldset key={index} className="entry-card">
                <div className="entry-card-header">
                  <span>{`Entry ${n}`}</span>
                  <button
                    type="button"
                    className="btn-danger-ghost"
                    aria-label={`Remove story ${n}`}
                    onClick={() =>
                      setProfile({
                        ...profile,
                        stories: profile.stories.filter((_, i) => i !== index),
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
                <div className="field-grid">
                  <div className="field">
                    <label htmlFor={`storyId${n}`}>{`Story id ${n}`}</label>
                    <input
                      id={`storyId${n}`}
                      value={entry.id}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          stories: profile.stories.map((s, i) =>
                            i === index ? { ...s, id: e.target.value } : s,
                          ),
                        })
                      }
                    />
                  </div>

                  <div className="field">
                    <label htmlFor={`storyTitle${n}`}>{`Story title ${n}`}</label>
                    <input
                      id={`storyTitle${n}`}
                      value={entry.title}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          stories: profile.stories.map((s, i) =>
                            i === index ? { ...s, title: e.target.value } : s,
                          ),
                        })
                      }
                    />
                  </div>

                  <div className="field span-2">
                    <label htmlFor={`storyTags${n}`}>{`Story tags ${n}`}</label>
                    <input
                      id={`storyTags${n}`}
                      value={entry.tags.join(', ')}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          stories: profile.stories.map((s, i) =>
                            i === index
                              ? {
                                  ...s,
                                  tags: e.target.value
                                    .split(',')
                                    .map((tag) => tag.trim())
                                    .filter(Boolean),
                                }
                              : s,
                          ),
                        })
                      }
                    />
                  </div>

                  <div className="field span-2">
                    <label htmlFor={`storySituation${n}`}>{`Situation ${n}`}</label>
                    <textarea
                      id={`storySituation${n}`}
                      value={entry.situation}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          stories: profile.stories.map((s, i) =>
                            i === index ? { ...s, situation: e.target.value } : s,
                          ),
                        })
                      }
                    />
                  </div>

                  <div className="field span-2">
                    <label htmlFor={`storyTask${n}`}>{`Task ${n}`}</label>
                    <textarea
                      id={`storyTask${n}`}
                      value={entry.task}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          stories: profile.stories.map((s, i) =>
                            i === index ? { ...s, task: e.target.value } : s,
                          ),
                        })
                      }
                    />
                  </div>

                  <div className="field span-2">
                    <label htmlFor={`storyAction${n}`}>{`Action ${n}`}</label>
                    <textarea
                      id={`storyAction${n}`}
                      value={entry.action}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          stories: profile.stories.map((s, i) =>
                            i === index ? { ...s, action: e.target.value } : s,
                          ),
                        })
                      }
                    />
                  </div>

                  <div className="field span-2">
                    <label htmlFor={`storyResult${n}`}>{`Result ${n}`}</label>
                    <textarea
                      id={`storyResult${n}`}
                      value={entry.result}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          stories: profile.stories.map((s, i) =>
                            i === index ? { ...s, result: e.target.value } : s,
                          ),
                        })
                      }
                    />
                  </div>
                </div>
              </fieldset>
            );
          })}
          <button
            type="button"
            className="btn-add"
            onClick={() =>
              setProfile({
                ...profile,
                stories: [
                  ...profile.stories,
                  {
                    id: '',
                    title: '',
                    tags: [],
                    situation: '',
                    task: '',
                    action: '',
                    result: '',
                  },
                ],
              })
            }
          >
            Add story
          </button>
        </fieldset>

        <div className="footer-save">
          <button type="submit" className="btn-primary">
            Save profile
          </button>
          {status && <p className={`status-pill ${status.kind}`}>{status.message}</p>}
        </div>
      </form>
    </main>
  );
}
