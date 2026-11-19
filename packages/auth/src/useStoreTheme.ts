import { useEffect } from 'react';
import { themeVars } from '@bestie/core';
import type { StoreTheme } from '@bestie/core';

/**
 * Put the owner's chosen colours on the document (only the ones chosen; everything else stays the built-in palette) and take
 * them off again when the shop or the theme changes. The values were checked for contrast before they were saved.
 */
export function useStoreTheme(theme: StoreTheme | undefined): void {
  const key = JSON.stringify(theme ?? {});
  useEffect(() => {
    const root = document.documentElement;
    const ink = getComputedStyle(root).getPropertyValue('--bp-ink').trim();
    const vars = themeVars(JSON.parse(key) as StoreTheme, ink);
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    return () => {
      for (const k of Object.keys(vars)) root.style.removeProperty(k);
    };
  }, [key]);
}
