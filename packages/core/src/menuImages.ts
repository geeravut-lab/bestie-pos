// Pictures of menu items: where a picture is served from, what the editor may send, and how a big photo is shrunk first.

/** The server accepts at most this many bytes per picture (the editor shrinks a photo well below it). */
export const MENU_IMAGE_MAX_BYTES = 256 * 1024;
/** Longest side the editor sends, in pixels. */
export const MENU_IMAGE_MAX_SIDE = 640;
export const MENU_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type MenuImageType = (typeof MENU_IMAGE_TYPES)[number];

export const isMenuImageType = (m: string): m is MenuImageType =>
  (MENU_IMAGE_TYPES as readonly string[]).includes(m);

/** The address of an item's picture, or null when it has none. The version is part of it: a new picture is a new address. */
export function menuImageUrl(itemId: string, version: number | null | undefined): string | null {
  if (!itemId || typeof version !== 'number' || !Number.isInteger(version) || version < 1)
    return null;
  return `/api/menu-image?i=${encodeURIComponent(itemId)}&v=${version}`;
}

/** Scale a picture so its longest side is at most `max`, keeping the shape; never enlarges. */
export function fitWithin(
  width: number,
  height: number,
  max = MENU_IMAGE_MAX_SIDE,
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 1, height: 1 };
  const k = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** Quality steps the editor tries until the picture fits the limit. */
export const QUALITY_STEPS = [0.85, 0.75, 0.65, 0.55, 0.45] as const;

export type PictureProblem = 'type' | 'size' | 'empty';

/** What is wrong with a file the person picked (before any shrinking), or null. 15 MB is plenty for a phone photo. */
export function pictureFileProblem(file: { type: string; size: number }): PictureProblem | null {
  if (file.size <= 0) return 'empty';
  if (!isMenuImageType(file.type)) return 'type';
  if (file.size > 15 * 1024 * 1024) return 'size';
  return null;
}
