import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime } from './format';

describe('date formatting', () => {
  it('always uses Asia/Bangkok (UTC+7), even for a UTC instant near midnight', () => {
    // 2026-11-17 18:30 UTC = 2026-11-18 01:30 in Bangkok
    expect(formatDateTime('en', '2026-11-17T18:30:00Z')).toContain('18 Nov 2026');
    expect(formatDateTime('en', '2026-11-17T18:30:00Z')).toContain('01:30');
  });
  it('shows the Buddhist era in Thai', () => {
    expect(formatDate('th', '2026-11-18T05:00:00Z')).toContain('2569');
  });
  it('returns an empty string for invalid input instead of throwing', () => {
    expect(formatDate('en', 'not a date')).toBe('');
    expect(formatDateTime('th', NaN)).toBe('');
  });
});
