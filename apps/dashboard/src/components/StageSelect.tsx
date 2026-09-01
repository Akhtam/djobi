/**
 * The stage badge, editable in place — a real `<select>` painted to look like the badge.
 *
 * A native select rather than a custom menu or a segmented radiogroup. It gets keyboard support,
 * the platform's own picker and correct overlay behaviour for free, and none of that is worth
 * reimplementing for four options. (The detail page used to carry a hand-built ARIA radiogroup
 * instead; a roving tabindex without arrow-key handling left it focusable but impossible to
 * operate by keyboard, which a `<select>` cannot get wrong.)
 *
 * The visible label is rendered as a sibling of the select rather than relying on the select's own
 * text, because a select's rendered value can't be styled consistently across browsers.
 *
 * The control is a **fixed width**, not sized to its current label. Stage names differ in length
 * ("Applied" against "Phone screen"), so an intrinsically-sized badge changes width when the value
 * changes — which would reflow a table row under the pointer at the moment of the click.
 */
import type { ApplicationStage } from '@djobi/shared';
import { STAGES, STAGE_LABELS, stageClass } from '../lib/stages';

export function StageSelect({
  stage,
  onChange,
  label,
  size = 'default',
}: {
  stage: ApplicationStage;
  onChange: (stage: ApplicationStage) => void;
  /** Names *which* application this control belongs to, since a list shows many of them. */
  label: string;
  /** `large` is the detail page's copy: same control, given the room that page has. */
  size?: 'default' | 'large';
}) {
  return (
    <span
      className={`stage-badge ${size === 'large' ? 'stage-badge--large' : ''} stage-badge--editable ${stageClass(stage)}`}
    >
      <span className="stage-badge__label">{STAGE_LABELS[stage]}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true" className="stage-badge__caret">
        <path d="m6 9 6 6 6-6" />
      </svg>
      <select
        className="stage-badge__select"
        aria-label={label}
        value={stage}
        onChange={(event) => onChange(event.target.value as ApplicationStage)}
      >
        {STAGES.map((option) => (
          <option key={option} value={option}>
            {STAGE_LABELS[option]}
          </option>
        ))}
      </select>
    </span>
  );
}
