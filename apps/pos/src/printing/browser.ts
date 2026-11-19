import { ensureReceiptFonts, renderReceiptCanvas, canvasToJpeg } from './canvas';
import type { Picture, PrintDeps } from './print';
import type { ReceiptRow } from './rows';

/** The real thing: a canvas in this browser. */
export const browserDeps = (rows: readonly ReceiptRow[]): PrintDeps => ({
  draw: async (widthDots): Promise<Picture> => {
    await ensureReceiptFonts();
    const canvas = renderReceiptCanvas(rows, widthDots);
    return {
      width: canvas.width,
      height: canvas.height,
      rgba: () => canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data,
      jpeg: () => canvasToJpeg(canvas),
    };
  },
  savePdf: (bytes, fileName) => {
    const url = URL.createObjectURL(
      new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  },
});
