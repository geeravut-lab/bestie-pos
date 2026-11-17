import { useEffect, useRef } from 'react';

/**
 * A bottom sheet that the device Back button closes (BACK-BUTTON knowledge): opening reserves ONE history entry,
 * Back pops it (= close, stay on the page), and closing any other way (✕ / backdrop / Esc) pops it too so history
 * never accumulates. Installed PWAs on iPad/iPhone have no browser chrome, so this matters.
 */
export function useBackClosableSheet(open: boolean, onClose: () => void): void {
  const reserved = useRef(false);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    history.pushState({ bestieSheet: true }, '');
    reserved.current = true;

    const onPop = () => {
      reserved.current = false; // the browser already popped our entry
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('keydown', onKey);
      if (reserved.current) {
        reserved.current = false;
        history.back(); // closed by ✕/backdrop/Esc/navigation: release the reserved entry
      }
    };
  }, [open]);
}
