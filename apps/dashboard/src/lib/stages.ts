/**
 * How an {@link ApplicationStage} is displayed — shared by the list badge, detail picker and filter
 * pills. Order comes from `ApplicationStageSchema.options`.
 */
import {
  ApplicationStageSchema,
  type ApplicationStage,
  type KeywordCategory,
  NoteCategorySchema,
  type NoteCategory,
  type RequirementEvidenceVerdict,
} from '@djobi/shared';

/** Every stage, in pipeline order. */
export const STAGES: readonly ApplicationStage[] = ApplicationStageSchema.options;

/**
 * The stages that mean an application is still live (the "in progress" count) — a judgement, so
 * hand-listed.
 */
export const IN_PROGRESS_STAGES: readonly ApplicationStage[] = ['phone_screen', 'onsite', 'offer'];

/**
 * The list's filter pills. The two rejections share one pill ("it ended"); rows still show which.
 * Hand-listed; a test asserts every stage maps to an existing pill via `stageFilterOf`.
 */
export const STAGE_FILTERS = [
  'applied',
  'phone_screen',
  'onsite',
  'offer',
  'rejected',
] as const satisfies readonly ApplicationStage[];

/** One of the {@link STAGE_FILTERS} — a filter value, which is narrower than a stage. */
export type StageFilter = (typeof STAGE_FILTERS)[number];

/** The two outcomes available inside the combined Rejected list filter. */
export const REJECTION_FILTERS = [
  'rejected',
  'rejected_ats',
] as const satisfies readonly ApplicationStage[];

export type RejectionFilter = (typeof REJECTION_FILTERS)[number];

export const REJECTION_FILTER_LABELS: Record<RejectionFilter, string> = {
  rejected_ats: 'ATS',
  rejected: 'Non-ATS',
};

/** The pill a stage falls under, and the normaliser for a `?stage=` in the URL. */
export function stageFilterOf(stage: ApplicationStage): StageFilter {
  return stage === 'rejected_ats' ? 'rejected' : stage;
}

/** Human-readable stage names. The enum values are snake_case and must not reach the screen. */
export const STAGE_LABELS: Record<ApplicationStage, string> = {
  applied: 'Applied',
  rejected_ats: 'Rejected (ATS)',
  phone_screen: 'Phone screen',
  onsite: 'Onsite',
  offer: 'Offer',
  rejected: 'Rejected',
};

/** A stage's colour modifier class; colours live in `App.css` on the shared token set. */
export function stageClass(stage: ApplicationStage): string {
  return `stage--${stage.replaceAll('_', '-')}`;
}

/** Every note category, in the order the schema declares them. */
export const NOTE_CATEGORIES: readonly NoteCategory[] = NoteCategorySchema.options;

/** Human-readable note category names. */
export const NOTE_CATEGORY_LABELS: Record<NoteCategory, string> = {
  technical: 'Technical',
  behavioral: 'Behavioral',
  general: 'General',
};

/** Display names for keyword categories (stored as lower-kebab). */
export const KEYWORD_CATEGORY_LABELS: Record<KeywordCategory, string> = {
  language: 'Language',
  framework: 'Framework',
  tool: 'Tool',
  platform: 'Platform',
  domain: 'Domain',
  'soft-skill': 'Soft skill',
};

/**
 * On-screen names for stored requirement verdicts, shared by `RequirementsPanel` and
 * `RequirementList`. `direct-evidence` is labelled for the roll-up but never badged on a row.
 */
export const EVIDENCE_LABELS: Record<RequirementEvidenceVerdict, string> = {
  'direct-evidence': 'Evidenced',
  'skill-only': 'Skill only',
  'omitted-profile-evidence': 'Dropped from resume',
  'needs-confirmation': 'Unconfirmed',
  unsupported: 'No evidence',
};
