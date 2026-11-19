import type { ReceiptRow } from './rows';

const FAMILY = '"Noto Sans Thai Variable", "Nunito Variable", system-ui, sans-serif';
const PAD = 12;

type Segmenter = { segment: (s: string) => Iterable<{ segment: string }> };

/** Break a line into pieces that fit `max` pixels. Thai has no spaces, so words come from Intl.Segmenter when the browser has it. */
export function wrapText(text: string, max: number, measure: (s: string) => number): string[] {
  const seg = (
    globalThis.Intl as unknown as { Segmenter?: new (l: string, o: object) => Segmenter }
  ).Segmenter;
  const words: string[] = seg
    ? [...new seg('th', { granularity: 'word' }).segment(text)].map((x) => x.segment)
    : text.split(/(?<=\s)/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (measure(line + w) <= max || line === '') {
      line += w;
      // a single "word" wider than the paper is cut by character
      while (measure(line) > max && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && measure(line.slice(0, cut)) > max) cut--;
        lines.push(line.slice(0, cut).trimEnd());
        line = line.slice(cut);
      }
    } else {
      lines.push(line.trimEnd());
      line = w.trimStart();
    }
  }
  if (line.trim() !== '' || lines.length === 0) lines.push(line.trimEnd());
  return lines;
}

/**
 * Draw the rows on a white canvas `widthDots` wide (one canvas pixel = one printer dot). Needs a browser: the fonts must be loaded
 * first (`ensureReceiptFonts`). The same canvas feeds the PDF and the ESC/POS raster, so what is printed equals what is saved.
 */
export function renderReceiptCanvas(
  rows: readonly ReceiptRow[],
  widthDots: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const probe = canvas.getContext('2d')!;
  const font = (px: number, bold = false) => `${bold ? '700' : '400'} ${px}px ${FAMILY}`;
  const inner = widthDots - PAD * 2;
  const LH = 1.35;

  type Drawn =
    | {
        y: number;
        kind: 'text';
        text: string;
        x: number;
        align: CanvasTextAlign;
        px: number;
        bold: boolean;
      }
    | { y: number; kind: 'rule' };
  const out: Drawn[] = [];
  let y = PAD;
  const textLines = (
    text: string,
    px: number,
    bold: boolean,
    align: CanvasTextAlign,
    x: number,
    max: number,
  ) => {
    probe.font = font(px, bold);
    for (const l of wrapText(text, max, (s) => probe.measureText(s).width)) {
      out.push({ y, kind: 'text', text: l, x, align, px, bold });
      y += Math.round(px * LH);
    }
  };

  for (const r of rows) {
    if (r.kind === 'rule') {
      y += 6;
      out.push({ y, kind: 'rule' });
      y += 12;
    } else if (r.kind === 'center') {
      const px = r.big ? 30 : 24;
      textLines(r.text, px, !!r.strong, 'center', widthDots / 2, inner);
    } else if (r.kind === 'note') {
      textLines(r.text, 20, false, 'center', widthDots / 2, inner);
    } else {
      const px = r.strong ? 28 : 24;
      probe.font = font(px, !!r.strong);
      const rightW = Math.ceil(probe.measureText(r.right).width);
      const start = y;
      textLines(r.left, px, !!r.strong, 'left', PAD, Math.max(60, inner - rightW - 16));
      out.push({
        y: start,
        kind: 'text',
        text: r.right,
        x: widthDots - PAD,
        align: 'right',
        px,
        bold: !!r.strong,
      });
      if (r.sub) textLines(r.sub, 20, false, 'left', PAD + 16, inner - 16);
    }
  }
  const height = y + PAD;
  canvas.width = widthDots;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, widthDots, height);
  ctx.fillStyle = 'black';
  ctx.textBaseline = 'top';
  for (const d of out) {
    if (d.kind === 'rule') {
      ctx.fillRect(PAD, d.y, inner, 2);
    } else {
      ctx.font = font(d.px, d.bold);
      ctx.textAlign = d.align;
      ctx.fillText(d.text, d.x, d.y);
    }
  }
  return canvas;
}

// A Thai letter (U+0E01) to make the browser load the Thai subset of the font.
const THAI_GLYPH = '\u0E01';

/** The two weights the receipt uses, loaded before drawing (a canvas draws a not-yet-loaded font in the fallback). */
export async function ensureReceiptFonts(): Promise<void> {
  try {
    await Promise.all([
      document.fonts.load(font400, THAI_GLYPH),
      document.fonts.load(font700, THAI_GLYPH),
      document.fonts.load(font400, 'A'),
    ]);
  } catch {
    /* the fallback font still prints something readable */
  }
}
const font400 = `400 24px ${FAMILY}`;
const font700 = `700 24px ${FAMILY}`;

export const canvasToJpeg = (canvas: HTMLCanvasElement): Promise<Uint8Array> =>
  new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) =>
        b
          ? b.arrayBuffer().then((x) => resolve(new Uint8Array(x)), reject)
          : reject(new Error('jpeg')),
      'image/jpeg',
      0.92,
    ),
  );
