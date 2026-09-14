/**
 * The stage badge, editable in place — a real `<select>` painted to look like the badge.
 *
 * A native select rather than a custom menu or a segmented radiogroup. It gets keyboard support,
 * the platform's own picker and correct overlay behaviour for free, and none of that is worth
 * reimplementing for four options. (The detail page used to carry a hand-built ARIA radiogroup
 * instead; a roving tabindex without arrow-key handling left it focusable but impossible to
 * operate by keyboard, which a `<select>` cannot get wrong.) The three-layer trick itself —
 * visible value, caret, invisible overlaid `<select>` — is `FakeSelect`'s; this names it for a
 * stage and supplies the badge's own look.
 *
 * The control is a **fixed width**, not sized to its current label. Stage names differ in length
 * ("Applied" against "Phone screen"), so an intrinsically-sized badge changes width when the value
 * changes — which would reflow a table row under the pointer at the moment of the click.
 */
import type { ApplicationStage } from '@djobi/shared';
import { FakeSelect } from './FakeSelect';
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
    <FakeSelect
      value={stage}
      options={STAGES}
      labels={STAGE_LABELS}
      ariaLabel={label}
      onChange={onChange}
      className={`stage-badge ${size === 'large' ? 'stage-badge--large' : ''} stage-badge--editable ${stageClass(stage)}`}
      valueClassName="stage-badge__label"
      caretClassName="stage-badge__caret"
      selectClassName="stage-badge__select"
    />
  );
}
