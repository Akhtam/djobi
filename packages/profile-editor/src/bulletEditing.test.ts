import { describe, expect, it } from 'vitest';
import type { WorkExperience } from '@djobi/shared';
import { parseBulletCap, toggleStarredBullet } from './bulletEditing.js';

const entry: WorkExperience = {
  company: 'Acme',
  title: 'Engineer',
  startDate: '2022-01',
  endDate: null,
  bullets: ['Shipped X', 'Shipped Y', 'Shipped Z'],
  maxBullets: null,
  starredIndices: [1],
  suppressIfEmpty: false,
};

describe('toggleStarredBullet', () => {
  it('stars an unstarred bullet, keeping indices sorted ascending', () => {
    expect(toggleStarredBullet(entry, 2).starredIndices).toEqual([1, 2]);
    expect(toggleStarredBullet({ ...entry, starredIndices: [2] }, 0).starredIndices).toEqual([
      0, 2,
    ]);
  });

  it('unstars an already-starred bullet', () => {
    expect(toggleStarredBullet(entry, 1).starredIndices).toEqual([]);
  });
});

describe('parseBulletCap', () => {
  it('clears the cap on an empty input', () => {
    expect(parseBulletCap('', NaN)).toBeNull();
  });

  it('accepts a non-negative integer', () => {
    expect(parseBulletCap('3', 3)).toBe(3);
    expect(parseBulletCap('0', 0)).toBe(0);
  });

  it('rejects a negative or non-integer value, signaling "ignore this keystroke"', () => {
    expect(parseBulletCap('-1', -1)).toBeUndefined();
    expect(parseBulletCap('1.5', 1.5)).toBeUndefined();
  });
});
