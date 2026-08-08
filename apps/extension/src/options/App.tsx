/** Options page root — profile onboarding form (`PROGRESS.md` Phase 5). */
import type { Profile } from '@djobi/shared';
import { useEffect, useState } from 'react';
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
    sendToBackground<Profile | null>('/profile', undefined, 'GET').then((loaded) => {
      setProfile(loaded ?? EMPTY_PROFILE);
    });
  }, []);

  if (!profile) {
    return (
      <main>
        <h1>djobi — Profile</h1>
        <p>Loading…</p>
      </main>
    );
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    sendToBackground<Profile>('/profile', profile)
      .then(() => setStatus({ kind: 'saved', message: 'Profile saved.' }))
      .catch((error: Error) => setStatus({ kind: 'error', message: error.message }));
  }

  return (
    <main>
      <h1>djobi — Profile</h1>
      <form onSubmit={handleSave}>
        <label htmlFor="fullName">Full name</label>
        <input
          id="fullName"
          value={profile.fullName}
          onChange={(e) => setProfile({ ...profile, fullName: e.target.value })}
        />

        <label htmlFor="email">Email</label>
        <input
          id="email"
          value={profile.email}
          onChange={(e) => setProfile({ ...profile, email: e.target.value })}
        />

        <label htmlFor="phone">Phone</label>
        <input
          id="phone"
          value={profile.phone ?? ''}
          onChange={(e) => setProfile({ ...profile, phone: e.target.value })}
        />

        <label htmlFor="location">Location</label>
        <input
          id="location"
          value={profile.location ?? ''}
          onChange={(e) => setProfile({ ...profile, location: e.target.value })}
        />

        <label htmlFor="summary">Summary</label>
        <textarea
          id="summary"
          value={profile.summary ?? ''}
          onChange={(e) => setProfile({ ...profile, summary: e.target.value })}
        />

        <label htmlFor="linkedin">LinkedIn</label>
        <input
          id="linkedin"
          value={profile.links.linkedin ?? ''}
          onChange={(e) =>
            setProfile({ ...profile, links: { ...profile.links, linkedin: e.target.value } })
          }
        />

        <label htmlFor="portfolio">Portfolio</label>
        <input
          id="portfolio"
          value={profile.links.portfolio ?? ''}
          onChange={(e) =>
            setProfile({ ...profile, links: { ...profile.links, portfolio: e.target.value } })
          }
        />

        <label htmlFor="github">GitHub</label>
        <input
          id="github"
          value={profile.links.github ?? ''}
          onChange={(e) =>
            setProfile({ ...profile, links: { ...profile.links, github: e.target.value } })
          }
        />

        <fieldset>
          <legend>Skills</legend>
          <ul>
            {profile.skills.map((skill) => (
              <li key={skill}>
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
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <label htmlFor="newSkill">New skill</label>
          <input id="newSkill" value={newSkill} onChange={(e) => setNewSkill(e.target.value)} />
          <button
            type="button"
            onClick={() => {
              if (!newSkill) return;
              setProfile({ ...profile, skills: [...profile.skills, newSkill] });
              setNewSkill('');
            }}
          >
            Add skill
          </button>
        </fieldset>

        <fieldset>
          <legend>Work experience</legend>
          {profile.workExperience.map((entry, index) => {
            const n = index + 1;
            return (
              <fieldset key={index}>
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

                <label htmlFor={`weBullets${n}`}>{`Bullets ${n}`}</label>
                <textarea
                  id={`weBullets${n}`}
                  value={entry.bullets.join('\n')}
                  onChange={(e) =>
                    setProfile({
                      ...profile,
                      workExperience: profile.workExperience.map((we, i) =>
                        i === index
                          ? { ...we, bullets: e.target.value.split('\n').filter(Boolean) }
                          : we,
                      ),
                    })
                  }
                />

                <button
                  type="button"
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
              </fieldset>
            );
          })}
          <button
            type="button"
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

        <fieldset>
          <legend>Education</legend>
          {profile.education.map((entry, index) => {
            const n = index + 1;
            return (
              <fieldset key={index}>
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

                <button
                  type="button"
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
              </fieldset>
            );
          })}
          <button
            type="button"
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

        <fieldset>
          <legend>Stories</legend>
          {profile.stories.map((entry, index) => {
            const n = index + 1;
            return (
              <fieldset key={index}>
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

                <button
                  type="button"
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
              </fieldset>
            );
          })}
          <button
            type="button"
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

        <button type="submit">Save profile</button>
      </form>
      {status && <p>{status.message}</p>}
    </main>
  );
}
