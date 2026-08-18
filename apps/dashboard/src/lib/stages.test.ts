import { ApplicationStageSchema } from '@djobi/shared';
import { describe, expect, it } from 'vitest';
import { IN_PROGRESS_STAGES, STAGES, STAGE_LABELS, stageClass } from './stages';

describe('stages', () => {
  it('takes its order from the schema rather than a hand-written copy', () => {
    expect(STAGES).toEqual(ApplicationStageSchema.options);
  });

  it('labels every stage, so no snake_case value can reach the screen', () => {
    for (const stage of STAGES) {
      expect(STAGE_LABELS[stage]).toBeTruthy();
      expect(STAGE_LABELS[stage]).not.toContain('_');
    }
  });

  it('turns a stage into a CSS-safe modifier', () => {
    expect(stageClass('phone_screen')).toBe('stage--phone-screen');
  });
});

describe('stageClass', () => {
  it('replaces every underscore, not just the first', () => {
    // `phone_screen` is the only multi-word stage today, so a single-replace bug is invisible
    // until a stage like this is added — at which point the colour silently stops applying.
    expect(stageClass('final_round_onsite' as never)).toBe('stage--final-round-onsite');
  });
});

describe('IN_PROGRESS_STAGES', () => {
  it('names only stages that exist', () => {
    for (const stage of IN_PROGRESS_STAGES) {
      expect(STAGES).toContain(stage);
    }
  });

  it('excludes the terminal and pre-contact stages', () => {
    expect(IN_PROGRESS_STAGES).not.toContain('rejected');
    expect(IN_PROGRESS_STAGES).not.toContain('applied');
  });
});
