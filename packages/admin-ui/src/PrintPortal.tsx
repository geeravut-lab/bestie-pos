import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Content that exists only on paper: rendered into #print-root at the end of <body>, hidden on screen, and the only thing shown when
 * the browser prints (see the print rules in shell.css). `pageCss` sets the paper (for example `@page { size: 50mm 30mm; margin: 0 }`).
 */
export function PrintPortal({ children, pageCss }: { children: ReactNode; pageCss?: string }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const el = document.createElement('div');
    el.id = 'print-root';
    document.body.appendChild(el);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the host element is an external DOM node that only exists after mount
    setHost(el);
    return () => {
      el.remove();
    };
  }, []);
  if (!host) return null;
  return createPortal(
    <>
      {pageCss ? <style>{`@media print { ${pageCss} }`}</style> : null}
      {children}
    </>,
    host,
  );
}
