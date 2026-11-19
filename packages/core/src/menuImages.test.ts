import { describe, expect, it } from 'vitest';
import { fitWithin, menuImageUrl, pictureFileProblem } from './menuImages';

describe('menuImageUrl', () => {
  it('builds an address with the version, so a changed picture is a new address', () => {
    expect(menuImageUrl('abc', 3)).toBe('/api/menu-image?i=abc&v=3');
    expect(menuImageUrl('abc', 4)).not.toBe(menuImageUrl('abc', 3));
  });
  it('no picture, no address', () => {
    expect(menuImageUrl('abc', null)).toBeNull();
    expect(menuImageUrl('abc', undefined)).toBeNull();
    expect(menuImageUrl('abc', 0)).toBeNull();
    expect(menuImageUrl('', 2)).toBeNull();
    expect(menuImageUrl('abc', 1.5)).toBeNull();
  });
});

describe('fitWithin', () => {
  it('shrinks the longest side to the limit and keeps the shape', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 640, height: 480 });
    expect(fitWithin(1000, 2000, 640)).toEqual({ width: 320, height: 640 });
  });
  it('never enlarges and never returns zero', () => {
    expect(fitWithin(300, 200)).toEqual({ width: 300, height: 200 });
    expect(fitWithin(5000, 1)).toEqual({ width: 640, height: 1 });
    expect(fitWithin(0, 10)).toEqual({ width: 1, height: 1 });
  });
});

describe('pictureFileProblem', () => {
  it('accepts JPEG, PNG and WebP', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp'])
      expect(pictureFileProblem({ type, size: 1000 })).toBeNull();
  });
  it('refuses other types (SVG can carry script), empty files and huge files', () => {
    expect(pictureFileProblem({ type: 'image/svg+xml', size: 1000 })).toBe('type');
    expect(pictureFileProblem({ type: 'application/pdf', size: 1000 })).toBe('type');
    expect(pictureFileProblem({ type: 'image/png', size: 0 })).toBe('empty');
    expect(pictureFileProblem({ type: 'image/png', size: 20 * 1024 * 1024 })).toBe('size');
  });
});
