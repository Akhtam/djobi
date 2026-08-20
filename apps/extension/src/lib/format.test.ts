import { ApplicationStageSchema } from '@djobi/shared';
import { describe, expect, it } from 'vitest';
import { formatStage } from './format';

describe('formatStage', () => {
  it('gives every stage a label with no snake_case left in it', () => {
    // Enumerated from the schema rather than hand-listed: this map is a copy of the dashboard's,
    // and the failure it has to catch is a stage added there and forgotten here.
    for (const stage of ApplicationStageSchema.options) {
      const label = formatStage(stage);
      expect(label).toBeTruthy();
      expect(label).not.toContain('_');
    }
  });

  it('spells out which rejection a row is', () => {
    expect(formatStage('rejected_ats')).toBe('Rejected (ATS)');
    expect(formatStage('rejected')).toBe('Rejected');
  });
});
