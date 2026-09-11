import { describe, expect, it, vi, afterEach } from 'vitest';
import { PROFILE_SECTIONS, scrollToSection, sectionsInGroup } from './profileSections.js';
import type { ProfileFieldsSectionKey, ProfileListSectionKey } from './profileSectionBodies.js';

describe('PROFILE_SECTIONS', () => {
  it('gives every section a unique anchor', () => {
    const anchors = PROFILE_SECTIONS.map((section) => section.anchor);
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it('anchors every section under the id prefix the stylesheets bind to', () => {
    for (const section of PROFILE_SECTIONS)
      expect(section.anchor.startsWith('section-')).toBe(true);
  });

  it('splits into the two tabs the dashboard renders, plus the upload that is in neither', () => {
    // A section that belongs to no group would vanish from the dashboard's quick-nav silently,
    // since it renders one group at a time.
    expect(sectionsInGroup('intake').map((section) => section.anchor)).toEqual(['section-upload']);
    expect(sectionsInGroup('profile')).not.toHaveLength(0);
    expect(sectionsInGroup('prep').map((section) => section.anchor)).toEqual([
      'section-screening',
      'section-answers',
      'section-stories',
    ]);
    expect(
      sectionsInGroup('intake').length +
        sectionsInGroup('profile').length +
        sectionsInGroup('prep').length,
    ).toBe(PROFILE_SECTIONS.length);
  });

  it('keeps each group in the inventory order', () => {
    const order = PROFILE_SECTIONS.map((section) => section.anchor);
    const profileGroup = sectionsInGroup('profile').map((section) => section.anchor);
    expect(profileGroup).toEqual(order.filter((anchor) => profileGroup.includes(anchor)));
  });

  it('exhaustively assigns every section to package fields, package list entries, or app composition', () => {
    const fields = new Set<ProfileFieldsSectionKey>([
      'contact',
      'links',
      'summary',
      'resume',
      'screening',
    ]);
    const lists = new Set<ProfileListSectionKey>([
      'work',
      'projects',
      'education',
      'credentials',
      'answers',
      'stories',
    ]);

    expect(
      PROFILE_SECTIONS.map(({ key, body }) => [
        key,
        fields.has(key as ProfileFieldsSectionKey)
          ? 'fields'
          : lists.has(key as ProfileListSectionKey)
            ? 'list'
            : 'app',
        body,
      ]),
    ).toEqual(PROFILE_SECTIONS.map(({ key, body }) => [key, body, body]));
    expect(PROFILE_SECTIONS.filter(({ body }) => body === 'app').map(({ key }) => key)).toEqual([
      'upload',
      'skills',
    ]);
  });
});

describe('scrollToSection', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('scrolls the section into view without touching the hash', () => {
    const hash = window.location.hash;
    const target = document.createElement('div');
    target.id = 'section-work';
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;
    document.body.append(target);

    scrollToSection('section-work');

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    // The dashboard reads an unrecognised hash as a route and bounces off the profile page.
    expect(window.location.hash).toBe(hash);
  });

  it('does nothing for an anchor that is not on the page', () => {
    expect(() => scrollToSection('section-missing')).not.toThrow();
  });
});
