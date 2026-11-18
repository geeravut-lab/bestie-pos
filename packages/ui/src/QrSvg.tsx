import qrcode from 'qrcode-generator';

/** A QR code as plain SVG shapes (no HTML injection): dark modules in ink on a white card. */
export function QrSvg({ value, label }: { value: string; label: string }) {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 3;
  const cells: string[] = [];
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.isDark(r, c)) cells.push(`M${c + quiet} ${r + quiet}h1v1h-1z`);
  const size = n + quiet * 2;
  return (
    <svg
      className="qr-svg"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="var(--bp-surface)" />
      <path d={cells.join('')} fill="var(--bp-ink)" />
    </svg>
  );
}
