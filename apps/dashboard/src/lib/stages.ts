/**
 * The one description of an {@link ApplicationStage} for display, shared by the three places a
 * stage is rendered: the list row's editable badge, the detail page's segmented picker, and the
 * list's filter pills.
 *
 * `ApplicationStageSchema.options` is the source of order, not a hand-written array. The schema
 * declares its values in pipeline order specifically so a picker can iterate them, and copying that
 * order here would create a second thing to remember when a stage is added.
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
 * The stages that mean an application is still live — the list header's "in progress" count.
 *
 * Hand-listed, and it has to be: "still live" is a judgement about which stages are which, not
 * something the enum's order can answer. It lives here beside `STAGES` rather than in the view
 * that renders it so that adding a stage puts every decision about that stage in one file.
 */
export const IN_PROGRESS_STAGES: readonly ApplicationStage[] = ['phone_screen', 'onsite', 'offer'];

/**
 * The stages the list's filter pills offer — one pill per option.
 *
 * Not `STAGES`. The two rejections share a pill: they are both "this one is over", and splitting
 * them across two pills puts two of the five options on the same outcome while making the common
 * case (show me everything that ended) take two clicks and a mental union. The distinction still
 * shows on every row's badge and is still set from the stage picker; it just isn't a filter.
 *
 * Hand-listed for the same reason {@link IN_PROGRESS_STAGES} is: which stages collapse together is
 * a judgement, not something the enum's order can answer. `stageFilterOf` is the other half — a
 * test asserts every stage lands on a pill that exists, so adding a stage without deciding this
 * fails rather than quietly vanishing from the filter row.
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

/**
 * The CSS modifier class for a stage's colour. The colours themselves live in `App.css` against
 * the same token set the extension uses, so dark mode needs no separate mapping here.
 */
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

/**
 * Human-readable keyword category names — `KeywordCategorySchema`'s enum values are lower-kebab
 * for storage, not for the screen. Shared by the Analytics keyword table and the detail page's
 * job-info tags, the same reason `STAGE_LABELS` is shared rather than duplicated per view.
 */
export const KEYWORD_CATEGORY_LABELS: Record<KeywordCategory, string> = {
  language: 'Language',
  framework: 'Framework',
  tool: 'Tool',
  platform: 'Platform',
  domain: 'Domain',
  'soft-skill': 'Soft skill',
};

/**
 * What each stored requirement verdict is called on screen.
 *
 * Here rather than beside either renderer, because both the Analytics roll-up
 * (`RequirementsPanel`) and one application's own list (`RequirementList`) name the same five
 * verdicts, and a vocabulary stated twice is a vocabulary that drifts.
 *
 * `direct-evidence` has a label because the roll-up counts it; no requirement row ever wears it —
 * the good case is the common case, and badging every evidenced requirement would bury the four
 * that mean something is wrong.
 */
export const EVIDENCE_LABELS: Record<RequirementEvidenceVerdict, string> = {
  'direct-evidence': 'Evidenced',
  'skill-only': 'Skill only',
  'omitted-profile-evidence': 'Dropped from resume',
  'needs-confirmation': 'Unconfirmed',
  unsupported: 'No evidence',
};
