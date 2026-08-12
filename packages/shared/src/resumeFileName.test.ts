import { describe, expect, it } from 'vitest';
import { resumeFileName } from './resumeFileName.js';

describe('resumeFileName', () => {
  it('joins the profile name with underscores', () => {
    expect(resumeFileName('Joe Doe')).toBe('joe_doe_resume.pdf');
  });

  it('collapses punctuation, extra whitespace and accents', () => {
    expect(resumeFileName('  José  van der Berg-Smith Jr. ')).toBe(
      'jose_van_der_berg_smith_jr_resume.pdf',
    );
  });

  it('falls back to a plain name when the profile name yields no slug', () => {
    expect(resumeFileName('')).toBe('resume.pdf');
    expect(resumeFileName('***')).toBe('resume.pdf');
  });
});
