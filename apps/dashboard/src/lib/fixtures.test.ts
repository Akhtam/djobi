import {
  ApplicationSchema,
  ApplicationSourceSchema,
  ApplicationStageSchema,
  NoteCategorySchema,
} from '@djobi/shared';
import { describe, expect, it } from 'vitest';
import { fixtureApplications } from './fixtures';

describe('fixtureApplications', () => {
  it('every fixture is a valid Application', () => {
    for (const application of fixtureApplications) {
      expect(() => ApplicationSchema.parse(application)).not.toThrow();
    }
  });

  it('has unique ids, so React keys and lookups behave', () => {
    const ids = fixtureApplications.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers every stage, so no stage colour goes unseen in development', () => {
    const covered = new Set(fixtureApplications.map((a) => a.stage));
    expect([...ApplicationStageSchema.options].every((stage) => covered.has(stage))).toBe(true);
  });

  it('covers every note category', () => {
    const covered = new Set(
      fixtureApplications.flatMap((a) => a.notes).map((note) => note.category),
    );
    expect([...NoteCategorySchema.options].every((category) => covered.has(category))).toBe(true);
  });

  it('covers every source, so the manual badge and its copy are seen in development', () => {
    const covered = new Set(fixtureApplications.map((a) => a.source));
    expect([...ApplicationSourceSchema.options].every((source) => covered.has(source))).toBe(true);
  });

  it('includes the empty-state rows the UI branches on', () => {
    expect(fixtureApplications.some((a) => a.notes.length === 0)).toBe(true);
    expect(fixtureApplications.some((a) => a.answers.length === 0)).toBe(true);
  });
});
