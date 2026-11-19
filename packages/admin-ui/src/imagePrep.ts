import { MENU_IMAGE_MAX_BYTES, QUALITY_STEPS, fitWithin } from '@bestie/core';

export type PreparedPicture = { mime: 'image/jpeg'; base64: string; bytes: number };

/**
 * Shrink a photo in the browser: longest side 640 px, JPEG, quality lowered step by step until it fits the server's limit.
 * (A phone photo of several MB becomes about 40–90 KB.) Throws 'decode' when the file cannot be read as a picture,
 * 'toobig' when even the lowest quality does not fit.
 */
export async function preparePicture(file: File): Promise<PreparedPicture> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('decode');
  }
  const { width, height } = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('decode');
  g.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  for (const q of QUALITY_STEPS) {
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/jpeg', q));
    if (!blob) throw new Error('decode');
    if (blob.size <= MENU_IMAGE_MAX_BYTES) {
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000)
        s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return { mime: 'image/jpeg', base64: btoa(s), bytes: blob.size };
    }
  }
  throw new Error('toobig');
}
