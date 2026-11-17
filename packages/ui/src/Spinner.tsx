/** Decorative spinner. Put it inside an element that already announces "busy" (see AsyncButton). */
export function Spinner({ className = '' }: { className?: string }) {
  return <span className={`spinner ${className}`.trim()} aria-hidden="true" />;
}
