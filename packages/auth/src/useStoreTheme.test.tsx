import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { StoreTheme } from '@bestie/core';
import { useStoreTheme } from './useStoreTheme';

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('style');
});
const Probe = ({ theme }: { theme?: StoreTheme }) => {
  useStoreTheme(theme);
  return null;
};
const prop = (n: string) => document.documentElement.style.getPropertyValue(n);

describe('useStoreTheme', () => {
  it('puts only the chosen colours on the document and removes them again', () => {
    document.documentElement.style.setProperty('--bp-ink', '#0f2d4a');
    const { rerender, unmount } = render(<Probe theme={{ sun: '#ffcb3d' }} />);
    expect(prop('--bp-sun')).toBe('#ffcb3d');
    expect(prop('--bp-primary')).toBe('');
    rerender(<Probe theme={{ primary: '#7a1f5c' }} />);
    expect(prop('--bp-sun')).toBe('');
    expect(prop('--bp-primary')).toBe('#7a1f5c');
    expect(prop('--bp-primary-hover')).toMatch(/^#[0-9a-f]{6}$/);
    unmount();
    expect(prop('--bp-primary')).toBe('');
  });
  it('no theme = nothing set', () => {
    render(<Probe />);
    expect(prop('--bp-primary')).toBe('');
  });
});
