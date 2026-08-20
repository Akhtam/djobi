import { ApplicationStageSchema } from '@djobi/shared';
import { describe, expect, it } from 'vitest';
import {
  IN_PROGRESS_STAGES,
  STAGE_FILTERS,
  STAGES,
  STAGE_LABELS,
  stageClass,
  stageFilterOf,
} from './stages';

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
    expect(IN_PROGRESS_STAGES).not.toContain('rejected_ats');
    expect(IN_PROGRESS_STAGES).not.toContain('applied');
  });
});

describe('STAGE_FILTERS', () => {
  it('offers one pill per filter and labels every one', () => {
    for (const filter of STAGE_FILTERS) {
      expect(STAGES).toContain(filter);
      expect(STAGE_LABELS[filter]).toBeTruthy();
    }
  });

  it('lands every stage on a pill that exists', () => {
    // The guard on adding a stage: a new one that nobody decided a home for would otherwise
    // disappear from the filter row, and its rows would be unreachable by any pill.
    for (const stage of STAGES) {
      expect(STAGE_FILTERS).toContain(stageFilterOf(stage));
    }
  });

  it('puts both rejections behind the one Rejected pill', () => {
    expect(stageFilterOf('rejected_ats')).toBe('rejected');
    expect(stageFilterOf('rejected')).toBe('rejected');
    expect(STAGE_FILTERS).not.toContain('rejected_ats');
  });

  it('leaves every other stage as its own pill', () => {
    for (const stage of STAGES) {
      if (stage === 'rejected_ats') continue;
      expect(stageFilterOf(stage)).toBe(stage);
    }
  });
});
