import { dotsFor, escposReceipt, imageToBits, receiptPdf } from '@bestie/core';
import type { Printer } from '@bestie/core';
import { PrintError, sendEscpos } from './drivers';
import type { PrintEnv } from './drivers';

/** A drawn receipt, however it was drawn: pixels for the ESC/POS raster, a JPEG for the PDF. Tests supply a fake. */
export type Picture = {
  width: number;
  height: number;
  rgba: () => ArrayLike<number>;
  jpeg: () => Promise<Uint8Array>;
};

export type PrintDeps = {
  /** Draw the receipt `widthDots` wide. */
  draw: (widthDots: number) => Promise<Picture>;
  /** Hand a PDF to the person (download). */
  savePdf: (bytes: Uint8Array, fileName: string) => void;
  env?: PrintEnv;
};

/** Everything except the browser dialog (the caller owns that: it prints the page that is already on screen). */
export async function printPicture(
  printer: Printer,
  title: string,
  deps: PrintDeps,
): Promise<void> {
  if (printer.kind === 'browser') throw new PrintError('unsupported');
  const widthDots = dotsFor(printer.paperMm);
  let pic: Picture;
  try {
    pic = await deps.draw(widthDots);
  } catch {
    throw new PrintError('failed');
  }
  if (printer.kind === 'pdf') {
    let jpeg: Uint8Array;
    try {
      jpeg = await pic.jpeg();
    } catch {
      throw new PrintError('failed');
    }
    deps.savePdf(
      receiptPdf({
        jpeg,
        widthPx: pic.width,
        heightPx: pic.height,
        paperMm: printer.paperMm,
        title,
      }),
      `${title.replace(/[^A-Za-z0-9+._-]+/g, '-').replace(/^-+|-+$/g, '') || 'receipt'}.pdf`,
    );
    return;
  }
  const bits = imageToBits(pic.rgba(), pic.width, pic.height);
  await sendEscpos(
    printer,
    escposReceipt(bits, pic.height, { cutter: printer.cutter, drawer: printer.drawer }),
    deps.env,
  );
}
