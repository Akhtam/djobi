/**
 * The stage badge, editable in place — a native `<select>` via `FakeSelect`, for free keyboard and
 * picker support. **Fixed width**, so a longer stage name doesn't reflow the row under the pointer.
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
