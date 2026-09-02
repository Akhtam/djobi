import type { Certification, ExtractedProfile, Profile, WorkExperience } from './schemas.js';
import type { ScreeningAnswers, ScreeningTopic } from './screeningAnswers.js';

export type CredentialKind = 'certification' | 'award';

/**
 * Moves one row between a Profile's `certifications` and `awards` arrays. The two share
 * `name`/`issuer`/`date`; only `description` is award-only, so a conversion carries the three
 * shared fields and drops or gains that one. The row reappears at the end of its new array —
 * there is no shared ordering field between the two for "keep the same position" to answer.
 */
export function changeCredentialKind(
  profile: Profile,
  index: number,
  from: CredentialKind,
  to: CredentialKind,
  shared: Pick<Certification, 'name' | 'issuer' | 'date'>,
): Profile {
  if (from === to) return profile;
  if (to === 'award') {
    return {
      ...profile,
      certifications: profile.certifications.filter((_, i) => i !== index),
      awards: [...profile.awards, shared],
    };
  }
  return {
    ...profile,
    awards: profile.awards.filter((_, i) => i !== index),
    certifications: [...profile.certifications, shared],
  };
}

/** Omits a cleared answer instead of storing an answered-but-empty topic. */
export function withScreeningAnswer(
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

/** Represents a cleared optional input consistently with the Profile schema. */
export function optionalText(value: string): string | null {
  return value.trim() ? value : null;
}

export function storyTags(value: string): string[] {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/** Applies one bullet-list splice and keeps source-index stars attached to the same bullets. */
export function spliceWorkBullets(
  entry: WorkExperience,
  index: number,
  deleteCount: number,
  ...inserted: string[]
): WorkExperience {
  const deletedEnd = index + deleteCount;
  const shift = inserted.length - deleteCount;
  const starredIndices = entry.starredIndices.flatMap((starredIndex) => {
    if (starredIndex < index) return [starredIndex];
    if (starredIndex < deletedEnd) return [];
    return [starredIndex + shift];
  });

  return {
    ...entry,
    bullets: [...entry.bullets.slice(0, index), ...inserted, ...entry.bullets.slice(deletedEnd)],
    starredIndices,
  };
}

/**
 * Copies a resume extraction's fields onto a Profile draft, field by field — never a blanket
 * replace. A field the extraction found populates the draft; a field it left null or empty (a
 * section the resume didn't have, or one the model couldn't confidently read) leaves the draft
 * exactly as it was.
 *
 * This is deliberately not a smart merge: there is no attempt to reconcile a field where both the
 * draft and the extraction have something, and the extraction always wins there. That is what
 * "review before save" is for (Phase 20 in `PROGRESS.md`) — the candidate sees the result in the
 * same editable fields as any other Profile edit and corrects anything wrong before saving; this
 * function only has to decide "did the extraction find something," not "which of two answers is
 * right." `||` rather than `??` throughout: an extracted `''` is exactly as much "nothing found" as
 * `null` is, for a field the candidate may already have filled in by hand.
 */
export function applyExtractedProfile(profile: Profile, extracted: ExtractedProfile): Profile {
  return {
    ...profile,
    fullName: extracted.fullName || profile.fullName,
    email: extracted.email || profile.email,
    phone: extracted.phone || profile.phone,
    location: extracted.location || profile.location,
    links: {
      linkedin: extracted.links.linkedin || profile.links.linkedin,
      portfolio: extracted.links.portfolio || profile.links.portfolio,
      github: extracted.links.github || profile.links.github,
    },
    summary: extracted.summary || profile.summary,
    // A resume's own work-experience/education entries carry no tailoring-selection controls
    // (`ExtractedProfileSchema` uses `ResumeWorkExperienceSchema`, not the full `WorkExperience`) —
    // every extracted role gets this Profile's defaults, the same ones a freshly added role gets.
    workExperience: extracted.workExperience.length
      ? extracted.workExperience.map((role) => ({
          ...role,
          maxBullets: null,
          starredIndices: [],
          suppressIfEmpty: false,
        }))
      : profile.workExperience,
    education: extracted.education.length ? extracted.education : profile.education,
    skills: extracted.skills.length ? extracted.skills : profile.skills,
    projects: extracted.projects.length ? extracted.projects : profile.projects,
    certifications: extracted.certifications.length
      ? extracted.certifications
      : profile.certifications,
    awards: extracted.awards.length ? extracted.awards : profile.awards,
  };
}

/** Normalizes transient form values into the Profile shape persisted by the backend. */
export function normalizeProfileDraft(profile: Profile, createStoryId: () => string): Profile {
  const idCounts = new Map<string, number>();
  const usedIds = new Set<string>();
  for (const story of profile.stories) {
    if (story.id.trim()) {
      idCounts.set(story.id, (idCounts.get(story.id) ?? 0) + 1);
      usedIds.add(story.id);
    }
  }

  const stories = profile.stories.map((story) => {
    if (story.id.trim() && idCounts.get(story.id) === 1) return story;

    let id = createStoryId();
    while (usedIds.has(id)) id = createStoryId();
    usedIds.add(id);
    return { ...story, id };
  });

  return {
    ...profile,
    workExperience: profile.workExperience.map((entry) => {
      let normalized = entry;
      for (let index = entry.bullets.length - 1; index >= 0; --index) {
        if (!entry.bullets[index].trim()) normalized = spliceWorkBullets(normalized, index, 1);
      }
      return normalized;
    }),
    // No starred-index bookkeeping here, unlike work experience: a project has no starring concept
    // to remap, so a plain filter is the whole operation.
    projects: profile.projects.map((project) => ({
      ...project,
      bullets: project.bullets.filter((bullet) => bullet.trim()),
    })),
    stories,
  };
}
