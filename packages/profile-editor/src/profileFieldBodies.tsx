/**
 * The controlled field bodies both Profile surfaces render — `apps/extension/src/options/App.tsx`
 * and `apps/dashboard/src/views/Profile.tsx`. Each function here is one section's (or one entry's)
 * inputs: their values, their `onChange`, their `type`, their autocomplete hints — everything a
 * caller does not have to reimplement to add a Profile field correctly a second time.
 *
 * What stays with each app is the {@link FieldChrome} it supplies (its own field/checkbox wrapper
 * and input class name), the section shell around a call here (`fieldset`+`legend` versus a panel
 * with a heading), and the `controls`/`summary` render props a `ListSection` takes — those render
 * as JSX one way in the extension and a plain string the other in the dashboard, which is a real
 * difference in presentation, not a duplicated fact.
 */
import type { ReactElement } from 'react';
import type { CredentialItem, ListEditor } from './listEditing.js';
import type { BulletListClassNames, FieldChrome } from './fieldChrome.js';
import { toggleStarredBullet, parseBulletCap } from './bulletEditing.js';
import {
  commaList,
  optionalList,
  optionalText,
  spliceProjectBullets,
  spliceWorkBullets,
  withScreeningAnswer,
} from './profileDraft.js';
import {
  SCREENING_TOPICS,
  type CustomAnswer,
  type Education,
  type Profile,
  type Project,
  type Story,
  type WorkExperience,
} from '@djobi/shared';

/** Contact details: name, email, phone, location. */
export function ContactFields({
  chrome,
  profile,
  onChange,
}: {
  chrome: FieldChrome;
  profile: Profile;
  onChange: (next: Profile) => void;
}): ReactElement {
  const { Field, controlClassName } = chrome;
  return (
    <>
      <Field id="fullName" label="Full name">
        <input
          id="fullName"
          className={controlClassName}
          autoComplete="name"
          value={profile.fullName}
          onChange={(e) => onChange({ ...profile, fullName: e.target.value })}
        />
      </Field>
      <Field id="email" label="Email">
        <input
          id="email"
          className={controlClassName}
          type="email"
          autoComplete="email"
          value={profile.email}
          onChange={(e) => onChange({ ...profile, email: e.target.value })}
        />
      </Field>
      <Field id="phone" label="Phone">
        <input
          id="phone"
          className={controlClassName}
          type="tel"
          autoComplete="tel"
          value={profile.phone ?? ''}
          onChange={(e) => onChange({ ...profile, phone: optionalText(e.target.value) })}
        />
      </Field>
      <Field id="location" label="Location">
        <input
          id="location"
          className={controlClassName}
          autoComplete="address-level2"
          value={profile.location ?? ''}
          onChange={(e) => onChange({ ...profile, location: optionalText(e.target.value) })}
        />
      </Field>
    </>
  );
}

/** LinkedIn, portfolio, GitHub. */
export function LinksFields({
  chrome,
  profile,
  onChange,
}: {
  chrome: FieldChrome;
  profile: Profile;
  onChange: (next: Profile) => void;
}): ReactElement {
  const { Field, controlClassName } = chrome;
  return (
    <>
      <Field id="linkedin" label="LinkedIn">
        <input
          id="linkedin"
          className={controlClassName}
          type="url"
          autoComplete="url"
          value={profile.links.linkedin ?? ''}
          onChange={(e) =>
            onChange({
              ...profile,
              links: { ...profile.links, linkedin: optionalText(e.target.value) },
            })
          }
        />
      </Field>
      <Field id="portfolio" label="Portfolio">
        <input
          id="portfolio"
          className={controlClassName}
          type="url"
          autoComplete="url"
          value={profile.links.portfolio ?? ''}
          onChange={(e) =>
            onChange({
              ...profile,
              links: { ...profile.links, portfolio: optionalText(e.target.value) },
            })
          }
        />
      </Field>
      <Field id="github" label="GitHub" span2>
        <input
          id="github"
          className={controlClassName}
          type="url"
          autoComplete="url"
          value={profile.links.github ?? ''}
          onChange={(e) =>
            onChange({
              ...profile,
              links: { ...profile.links, github: optionalText(e.target.value) },
            })
          }
        />
      </Field>
    </>
  );
}

/** The resume's intro paragraph. */
export function SummaryField({
  chrome,
  profile,
  onChange,
}: {
  chrome: FieldChrome;
  profile: Profile;
  onChange: (next: Profile) => void;
}): ReactElement {
  const { Field, controlClassName } = chrome;
  return (
    <Field id="summary" label="Summary" span2>
      <textarea
        id="summary"
        value={profile.summary ?? ''}
        onChange={(e) => onChange({ ...profile, summary: optionalText(e.target.value) })}
      />
    </Field>
  );
}

/** Page size and the role-prefix toggle — how the generated PDF is formatted. */
export function ResumeSettingsFields({
  chrome,
  profile,
  onChange,
}: {
  chrome: FieldChrome;
  profile: Profile;
  onChange: (next: Profile) => void;
}): ReactElement {
  const { Field, Checkbox, controlClassName } = chrome;
  return (
    <>
      <Field id="resumePageSize" label="Page size">
        <select
          id="resumePageSize"
          className={controlClassName}
          value={profile.resumePageSize}
          onChange={(event) =>
            onChange({
              ...profile,
              resumePageSize: event.currentTarget.value as Profile['resumePageSize'],
            })
          }
        >
          <option value="A4">A4</option>
          <option value="LETTER">Letter</option>
        </select>
      </Field>
      <Checkbox
        id="showRolePrefix"
        label="Prefix titles with “Role:”"
        checked={profile.showRolePrefix}
        onChange={(checked) => onChange({ ...profile, showRolePrefix: checked })}
      />
    </>
  );
}

/** One work-experience entry's fields, including its bullet bank and starring. */
export function WorkExperienceEntryFields({
  chrome,
  bulletListClassNames,
  entry,
  index,
  maxBulletsPerRole,
  work,
}: {
  chrome: FieldChrome;
  bulletListClassNames: BulletListClassNames;
  entry: WorkExperience;
  index: number;
  maxBulletsPerRole: number;
  work: ListEditor<WorkExperience>;
}): ReactElement {
  const { Field, Checkbox, controlClassName } = chrome;
  const n = index + 1;
  return (
    <>
      <Field id={`weCompany${n}`} label={`Company ${n}`}>
        <input
          id={`weCompany${n}`}
          className={controlClassName}
          value={entry.company}
          onChange={(e) => work.update(index, { company: e.target.value })}
        />
      </Field>
      <Field id={`weTitle${n}`} label={`Title ${n}`}>
        <input
          id={`weTitle${n}`}
          className={controlClassName}
          value={entry.title}
          onChange={(e) => work.update(index, { title: e.target.value })}
        />
      </Field>
      <Field id={`weStartDate${n}`} label={`Start date ${n}`}>
        <input
          id={`weStartDate${n}`}
          className={controlClassName}
          value={entry.startDate}
          onChange={(e) => work.update(index, { startDate: e.target.value })}
        />
      </Field>
      <Field id={`weEndDate${n}`} label={`End date ${n}`}>
        <input
          id={`weEndDate${n}`}
          className={controlClassName}
          value={entry.endDate ?? ''}
          onChange={(e) => work.update(index, { endDate: optionalText(e.target.value) })}
        />
      </Field>
      <Field id={`weMaxBullets${n}`} label={`Bullet cap ${n}`}>
        <input
          id={`weMaxBullets${n}`}
          className={controlClassName}
          type="number"
          min="0"
          step="1"
          placeholder={`Inherit ${maxBulletsPerRole}`}
          value={entry.maxBullets ?? ''}
          onChange={(event) => {
            const cap = parseBulletCap(
              event.currentTarget.value,
              event.currentTarget.valueAsNumber,
            );
            if (cap !== undefined) work.update(index, { maxBullets: cap });
          }}
        />
      </Field>
      <Checkbox
        id={`weSuppressIfEmpty${n}`}
        label={`Hide role ${n} entirely if tailoring selects no bullets for it`}
        checked={entry.suppressIfEmpty}
        onChange={(checked) => work.update(index, { suppressIfEmpty: checked })}
      />
      <Field id={`weBullets${n}`} label={`Bullets ${n}`} span2>
        <div className={bulletListClassNames.list}>
          {entry.bullets.map((bullet, bulletIndex) => (
            <div key={bulletIndex} className={bulletListClassNames.row}>
              <button
                type="button"
                className={bulletListClassNames.starButton}
                aria-label={`${
                  entry.starredIndices.includes(bulletIndex) ? 'Unstar' : 'Star'
                } bullet ${n}.${bulletIndex + 1}`}
                aria-pressed={entry.starredIndices.includes(bulletIndex)}
                onClick={() => work.update(index, toggleStarredBullet(entry, bulletIndex))}
              >
                <span aria-hidden="true">
                  {entry.starredIndices.includes(bulletIndex) ? '★' : '☆'}
                </span>
              </button>
              <input
                className={controlClassName}
                aria-label={`Bullet ${n}.${bulletIndex + 1}`}
                value={bullet}
                onChange={(e) =>
                  work.update(index, spliceWorkBullets(entry, bulletIndex, 1, e.target.value))
                }
              />
              <button
                type="button"
                className={bulletListClassNames.removeButton}
                aria-label={`Remove bullet ${n}.${bulletIndex + 1}`}
                onClick={() => work.update(index, spliceWorkBullets(entry, bulletIndex, 1))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className={bulletListClassNames.addButton}
          onClick={() => work.update(index, spliceWorkBullets(entry, entry.bullets.length, 0, ''))}
        >
          + Add bullet
        </button>
      </Field>
    </>
  );
}

/** One project's fields, including its own bullet list (no starring — that's work experience only). */
export function ProjectEntryFields({
  chrome,
  bulletListClassNames,
  entry,
  index,
  projects,
}: {
  chrome: FieldChrome;
  bulletListClassNames: BulletListClassNames;
  entry: Project;
  index: number;
  projects: ListEditor<Project>;
}): ReactElement {
  const { Field, controlClassName } = chrome;
  const n = index + 1;
  return (
    <>
      <Field id={`projName${n}`} label={`Name ${n}`}>
        <input
          id={`projName${n}`}
          className={controlClassName}
          value={entry.name}
          onChange={(e) => projects.update(index, { name: e.target.value })}
        />
      </Field>
      <Field id={`projLink${n}`} label={`Link ${n}`}>
        <input
          id={`projLink${n}`}
          className={controlClassName}
          type="url"
          value={entry.link ?? ''}
          onChange={(e) => projects.update(index, { link: optionalText(e.target.value) })}
        />
      </Field>
      <Field id={`projDescription${n}`} label={`Description ${n}`} span2>
        <textarea
          id={`projDescription${n}`}
          value={entry.description}
          onChange={(e) => projects.update(index, { description: e.target.value })}
        />
      </Field>
      <Field id={`projTechnologies${n}`} label={`Technologies ${n}`} span2>
        <input
          id={`projTechnologies${n}`}
          className={controlClassName}
          placeholder="Comma-separated"
          value={(entry.technologies ?? []).join(', ')}
          onChange={(e) => projects.update(index, { technologies: optionalList(e.target.value) })}
        />
      </Field>
      <Field id={`projBullets${n}`} label={`Bullets ${n}`} span2>
        <div className={bulletListClassNames.list}>
          {entry.bullets.map((bullet, bulletIndex) => (
            <div key={bulletIndex} className={bulletListClassNames.row}>
              <input
                className={controlClassName}
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
                className={bulletListClassNames.removeButton}
                aria-label={`Remove project ${n} bullet ${bulletIndex + 1}`}
                onClick={() => projects.update(index, spliceProjectBullets(entry, bulletIndex, 1))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className={bulletListClassNames.addButton}
          onClick={() =>
            projects.update(index, spliceProjectBullets(entry, entry.bullets.length, 0, ''))
          }
        >
          + Add bullet
        </button>
      </Field>
    </>
  );
}

/** One education entry's fields. */
export function EducationEntryFields({
  chrome,
  entry,
  index,
  education,
}: {
  chrome: FieldChrome;
  entry: Education;
  index: number;
  education: ListEditor<Education>;
}): ReactElement {
  const { Field, controlClassName } = chrome;
  const n = index + 1;
  return (
    <>
      <Field id={`eduSchool${n}`} label={`School ${n}`}>
        <input
          id={`eduSchool${n}`}
          className={controlClassName}
          value={entry.school}
          onChange={(e) => education.update(index, { school: e.target.value })}
        />
      </Field>
      <Field id={`eduDegree${n}`} label={`Degree ${n}`}>
        <input
          id={`eduDegree${n}`}
          className={controlClassName}
          value={entry.degree}
          onChange={(e) => education.update(index, { degree: e.target.value })}
        />
      </Field>
      <Field id={`eduField${n}`} label={`Field ${n}`}>
        <input
          id={`eduField${n}`}
          className={controlClassName}
          value={entry.field ?? ''}
          onChange={(e) => education.update(index, { field: optionalText(e.target.value) })}
        />
      </Field>
      <Field id={`eduGradYear${n}`} label={`Graduation year ${n}`}>
        <input
          id={`eduGradYear${n}`}
          className={controlClassName}
          value={entry.graduationYear ?? ''}
          onChange={(e) =>
            education.update(index, { graduationYear: optionalText(e.target.value) })
          }
        />
      </Field>
    </>
  );
}

/** One Certifications & Awards row — the description field only shows for an award. */
export function CredentialEntryFields({
  chrome,
  item,
  index,
  editor,
  changeKind,
}: {
  chrome: FieldChrome;
  item: CredentialItem;
  index: number;
  editor: ListEditor<CredentialItem>;
  changeKind: (item: CredentialItem, kind: CredentialItem['kind']) => void;
}): ReactElement {
  const { Field, controlClassName } = chrome;
  const n = index + 1;
  return (
    <>
      <Field id={`credKind${n}`} label={`Type ${n}`}>
        <select
          id={`credKind${n}`}
          className={controlClassName}
          value={item.kind}
          onChange={(e) => changeKind(item, e.currentTarget.value as CredentialItem['kind'])}
        >
          <option value="certification">Certification</option>
          <option value="award">Award</option>
        </select>
      </Field>
      <Field id={`credName${n}`} label={`Name ${n}`}>
        <input
          id={`credName${n}`}
          className={controlClassName}
          value={item.name}
          onChange={(e) => editor.update(index, { name: e.target.value })}
        />
      </Field>
      <Field id={`credIssuer${n}`} label={`Issuer ${n}`}>
        <input
          id={`credIssuer${n}`}
          className={controlClassName}
          value={item.issuer}
          onChange={(e) => editor.update(index, { issuer: e.target.value })}
        />
      </Field>
      <Field id={`credDate${n}`} label={`Date ${n}`}>
        <input
          id={`credDate${n}`}
          className={controlClassName}
          value={item.date}
          onChange={(e) => editor.update(index, { date: e.target.value })}
        />
      </Field>
      {item.kind === 'award' && (
        <Field id={`credDescription${n}`} label={`Description ${n}`} span2>
          <textarea
            id={`credDescription${n}`}
            value={item.description ?? ''}
            onChange={(e) =>
              editor.update(index, { description: optionalText(e.target.value) ?? undefined })
            }
          />
        </Field>
      )}
    </>
  );
}

/**
 * The screening-answer grid — one input per {@link SCREENING_TOPICS} entry, each with its own
 * suggestion list. Not a `ListSection`: the set of topics is fixed, so there is nothing to add or
 * remove, only to fill in or leave blank.
 */
export function ScreeningAnswerFields({
  chrome,
  profile,
  onChange,
}: {
  chrome: FieldChrome;
  profile: Profile;
  onChange: (next: Profile) => void;
}): ReactElement {
  const { Field, controlClassName } = chrome;
  return (
    <>
      {SCREENING_TOPICS.map((entry) => (
        <Field key={entry.topic} id={entry.topic} label={entry.label}>
          <input
            id={entry.topic}
            className={controlClassName}
            list={`${entry.topic}-suggestions`}
            value={profile.screeningAnswers[entry.topic] ?? ''}
            onChange={(e) =>
              onChange({
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
        </Field>
      ))}
    </>
  );
}

/** One "other prepared answer" entry — a freeform question and its drafted answer. */
export function CustomAnswerEntryFields({
  chrome,
  entry,
  index,
  customAnswers,
}: {
  chrome: FieldChrome;
  entry: CustomAnswer;
  index: number;
  customAnswers: ListEditor<CustomAnswer>;
}): ReactElement {
  const { Field, controlClassName } = chrome;
  return (
    <>
      <Field id={`customQuestion-${index}`} label="Question">
        <input
          id={`customQuestion-${index}`}
          className={controlClassName}
          value={entry.question}
          onChange={(e) => customAnswers.update(index, { question: e.target.value })}
        />
      </Field>
      <Field id={`customAnswer-${index}`} label="Answer">
        <textarea
          id={`customAnswer-${index}`}
          value={entry.answer}
          onChange={(e) => customAnswers.update(index, { answer: e.target.value })}
        />
      </Field>
    </>
  );
}

/** One STAR story's fields. */
export function StoryEntryFields({
  chrome,
  entry,
  index,
  stories,
}: {
  chrome: FieldChrome;
  entry: Story;
  index: number;
  stories: ListEditor<Story>;
}): ReactElement {
  const { Field, controlClassName } = chrome;
  const n = index + 1;
  return (
    <>
      <Field id={`storyId${n}`} label={`Story id ${n}`}>
        <input
          id={`storyId${n}`}
          className={controlClassName}
          value={entry.id}
          onChange={(e) => stories.update(index, { id: e.target.value })}
        />
      </Field>
      <Field id={`storyTitle${n}`} label={`Story title ${n}`}>
        <input
          id={`storyTitle${n}`}
          className={controlClassName}
          value={entry.title}
          onChange={(e) => stories.update(index, { title: e.target.value })}
        />
      </Field>
      <Field id={`storyTags${n}`} label={`Story tags ${n}`} span2>
        <input
          id={`storyTags${n}`}
          className={controlClassName}
          value={entry.tags.join(', ')}
          onChange={(e) => stories.update(index, { tags: commaList(e.target.value) })}
        />
      </Field>
      <Field id={`storySituation${n}`} label={`Situation ${n}`} span2>
        <textarea
          id={`storySituation${n}`}
          value={entry.situation}
          onChange={(e) => stories.update(index, { situation: e.target.value })}
        />
      </Field>
      <Field id={`storyTask${n}`} label={`Task ${n}`} span2>
        <textarea
          id={`storyTask${n}`}
          value={entry.task}
          onChange={(e) => stories.update(index, { task: e.target.value })}
        />
      </Field>
      <Field id={`storyAction${n}`} label={`Action ${n}`} span2>
        <textarea
          id={`storyAction${n}`}
          value={entry.action}
          onChange={(e) => stories.update(index, { action: e.target.value })}
        />
      </Field>
      <Field id={`storyResult${n}`} label={`Result ${n}`} span2>
        <textarea
          id={`storyResult${n}`}
          value={entry.result}
          onChange={(e) => stories.update(index, { result: e.target.value })}
        />
      </Field>
    </>
  );
}
