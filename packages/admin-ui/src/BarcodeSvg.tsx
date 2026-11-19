import { barRuns, code128B } from '@bestie/core';

/** A Code 128 barcode as an SVG that stretches to its box (quiet zones included). */
export function BarcodeSvg({ code, label }: { code: string; label: string }) {
  const modules = code128B(code);
  const quiet = 10;
  return (
    <svg
      className="barcode-svg"
      viewBox={`0 0 ${modules.length + 2 * quiet} 1`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      {barRuns(modules).map((r) => (
        <rect key={r.x} x={r.x + quiet} y={0} width={r.w} height={1} fill="currentColor" />
      ))}
    </svg>
  );
}
