import {
  matchOptionLabel,
  TailoredResumeSchema,
  type JobInfo,
  type TailorResumeProfile,
  type TailoredResume,
} from '@djobi/shared';
import { MODELS } from './client.js';
import { groundingContext } from './promptContext.js';
import { callStructured } from './structuredCall.js';

type ResumeEntry = TailoredResume['workExperience'][number];

function metadataKey(entry: ResumeEntry): string {
  return JSON.stringify([entry.company, entry.title, entry.startDate, entry.endDate]);
}

/** Keeps model-authored content only where it can be attached to one authoritative profile entry. */
function reconcileResume(
  profile: TailorResumeProfile,
  modelResume: TailoredResume,
): TailoredResume {
  const profileKeyCounts = new Map<string, number>();
  const modelKeyCounts = new Map<string, number>();
  for (const entry of profile.workExperience) {
    const key = metadataKey(entry);
    profileKeyCounts.set(key, (profileKeyCounts.get(key) ?? 0) + 1);
  }
  for (const entry of modelResume.workExperience) {
    const key = metadataKey(entry);
    modelKeyCounts.set(key, (modelKeyCounts.get(key) ?? 0) + 1);
  }

  const safelyKeyedModelEntries = modelResume.workExperience.filter((entry) => {
    const key = metadataKey(entry);
    return profileKeyCounts.get(key) === 1 && modelKeyCounts.get(key) === 1;
  });
  const safelyReordered = safelyKeyedModelEntries.length === profile.workExperience.length;

  let workExperience: ResumeEntry[];
  if (safelyReordered) {
    const profileByKey = new Map(
      profile.workExperience.map((entry) => [metadataKey(entry), entry] as const),
    );
    workExperience = safelyKeyedModelEntries.map((entry) => ({
      ...profileByKey.get(metadataKey(entry))!,
      bullets: entry.bullets,
    }));
  } else {
    const usedModelIndexes = new Set<number>();
    workExperience = profile.workExperience.map((profileEntry) => {
      const key = metadataKey(profileEntry);
      const modelIndex = modelResume.workExperience.findIndex(
        (entry, index) =>
          !usedModelIndexes.has(index) &&
          metadataKey(entry) === key &&
          profileKeyCounts.get(key) === 1 &&
          modelKeyCounts.get(key) === 1,
      );
      if (modelIndex < 0) return { ...profileEntry, bullets: profileEntry.bullets };
      usedModelIndexes.add(modelIndex);
      return { ...profileEntry, bullets: modelResume.workExperience[modelIndex].bullets };
    });
  }

  const seenSkills = new Set<string>();
  const skills = modelResume.skills.flatMap((skill) => {
    const match = matchOptionLabel(profile.skills, skill);
    if (!match || seenSkills.has(match)) return [];
    seenSkills.add(match);
    return [match];
  });

  return { skills, workExperience };
}

/**
 * Tailors a resume's content to a specific job, using the writing model (`MODELS.writing`).
 * Reorders/rewords the profile's existing experience bullets to emphasize what's relevant to the
 * job's requirements/keywords; the prompt explicitly forbids inventing experience not present in
 * `profile`.
 *
 * @param profile - The candidate's base profile (source of truth — nothing is invented beyond it).
 * @param jobInfo - The job to tailor toward, as extracted by {@link extractJob}.
 * @returns The tailored, validated {@link TailoredResume}.
 * @throws If the model doesn't return a tool call, or returns one that fails validation.
 */
export async function tailorResume(
  profile: TailorResumeProfile,
  jobInfo: JobInfo,
): Promise<TailoredResume> {
  const relevantProfile = {
    workExperience: profile.workExperience,
    skills: profile.skills,
  };

  const modelResume = await callStructured({
    model: MODELS.writing,
    maxTokens: 4096,
    toolName: 'report_tailored_resume',
    toolDescription: 'Report the resume content tailored to this specific job.',
    schema: TailoredResumeSchema,
    userContent: `You are tailoring a resume to a specific job posting. Reorder and reword the candidate's existing experience bullets to emphasize what's relevant to this job's requirements and keywords. Never invent experience, skills, or achievements that are not present in the base profile. Return every work-experience entry exactly once. Copy company, title, startDate, and endDate verbatim; only bullets may be rewritten. Skills must be copied verbatim from base_profile.skills and may only be reordered or omitted.

${groundingContext(relevantProfile, jobInfo)}
`,
  });

  return reconcileResume(profile, modelResume);
}
