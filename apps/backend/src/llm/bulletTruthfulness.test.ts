import { describe, expect, it } from 'vitest';
import { verifyBulletRewrite } from './bulletTruthfulness.js';

describe('verifyBulletRewrite', () => {
  it('keeps a rewrite that introduces no new numbers or proper-noun-like terms', () => {
    const source = 'Led the billing service migration off the legacy vendor';
    const rewrite = 'Led a billing service migration away from the legacy vendor';

    expect(verifyBulletRewrite(rewrite, source)).toBe(rewrite);
  });

  it('keeps a rewrite whose number already appears in the source', () => {
    const source = 'Cut checkout latency from 1.8s to 400ms';
    const rewrite = 'Reduced checkout latency to 400ms, down from 1.8s';

    expect(verifyBulletRewrite(rewrite, source)).toBe(rewrite);
  });

  it('reverts to the source, verbatim, when the rewrite invents a metric the source never stated', () => {
    const source = 'Improved checkout latency for the payments team';
    const rewrite = 'Cut checkout latency by 40% for the payments team';

    expect(verifyBulletRewrite(rewrite, source)).toBe(source);
  });

  it('reverts to the source when the rewrite names a technology the source never mentioned', () => {
    const source = 'Migrated the fleet to a container orchestrator';
    const rewrite = 'Migrated the fleet to Kubernetes';

    expect(verifyBulletRewrite(rewrite, source)).toBe(source);
  });

  it('keeps a rewrite that reuses a proper-noun-like term already present in the source', () => {
    const source = 'Operated the Kubernetes clusters backing checkout';
    const rewrite = 'Ran production Kubernetes clusters for checkout';

    expect(verifyBulletRewrite(rewrite, source)).toBe(rewrite);
  });

  it('does not flag ordinary sentence-initial capitalization as an invented claim', () => {
    const source = 'Rebuilt the onboarding flow end to end';
    const rewrite = 'Rebuilt the onboarding flow end to end for new hires';

    expect(verifyBulletRewrite(rewrite, source)).toBe(rewrite);
  });

  it('reverts when a rewrite invents a scale claim the source has no number for at all', () => {
    const source = 'Owned the on-call rotation for the platform team';
    const rewrite = 'Owned the on-call rotation for a team of 12 engineers';

    expect(verifyBulletRewrite(rewrite, source)).toBe(source);
  });

  it('ignores case when checking whether a claim already appears in the source', () => {
    const source = 'Built the internal REACT component library';
    const rewrite = 'Built the internal React component library';

    expect(verifyBulletRewrite(rewrite, source)).toBe(rewrite);
  });

  it('does not misread the word after an abbreviation as a sentence-initial, unchecked claim', () => {
    const source = 'Partnered with the vendor to scale the platform';
    // Without an abbreviation guard, "Corp." reads as ending the sentence, so "Kubernetes" reads as
    // sentence-initial and is never checked against the source.
    const rewrite = 'Partnered with Acme Corp. Kubernetes powered the new platform';

    expect(verifyBulletRewrite(rewrite, source)).toBe(source);
  });

  it('keeps a rewrite whose hyphenated compound is grounded in a source proper noun', () => {
    const source = 'Operated Kubernetes clusters for checkout';
    const rewrite = 'Modernized the platform with a Kubernetes-based rollout';

    expect(verifyBulletRewrite(rewrite, source)).toBe(rewrite);
  });
});
