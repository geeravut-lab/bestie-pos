import type { SupabaseClient } from '@supabase/supabase-js';
import {
  brandObjectPath,
  brandToColumn,
  checkFavicon,
  checkLogo,
  validBrandName,
} from '@bestie/core';
import type { Brand, BrandImage, BrandImageKind, ImageProblem } from '@bestie/core';
import { AppError } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';

const PROBLEM: Record<ImageProblem, ErrorKey> = {
  too_big: 'err_brand_too_big',
  bad_type: 'err_brand_bad_type',
  not_png: 'err_brand_not_png',
  not_square: 'err_brand_not_square',
  too_small: 'err_brand_too_small',
  too_large: 'err_brand_too_large',
};

const BUCKET = 'brand-assets';

/** Write the brand row. An UPDATE that touches no row is "success" to PostgREST, so count rows (knowledge rule #1). */
async function writeBrand(client: SupabaseClient, next: Brand): Promise<void> {
  const { data, error } = await client
    .from('platform_settings')
    .update({ brand: brandToColumn(next) })
    .eq('id', true)
    .select('id');
  if (error || data?.length !== 1)
    throw new AppError(error?.code === '42501' ? 'err_forbidden' : 'err_save_failed');
}

export async function saveBrandNames(
  client: SupabaseClient,
  current: Brand,
  names: { nameTh: string; nameEn: string },
): Promise<Brand> {
  const nameTh = names.nameTh.trim();
  const nameEn = names.nameEn.trim();
  if ((nameTh && !validBrandName(nameTh)) || (nameEn && !validBrandName(nameEn)))
    throw new AppError('err_brand_name_invalid');
  const next: Brand = { ...current, nameTh: nameTh || undefined, nameEn: nameEn || undefined };
  await writeBrand(client, next);
  return next;
}

/**
 * Upload order (BRANDING-KNOWLEDGE §3.2): check bytes → upload the NEW versioned file → point the settings at it →
 * only then delete the old file. If pointing fails the new file is removed, so the old image keeps working and there is
 * never a moment without an image.
 */
export async function uploadBrandImage(
  client: SupabaseClient,
  kind: BrandImageKind,
  file: Blob,
  current: Brand,
): Promise<Brand> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const checked = kind === 'logo' ? checkLogo(bytes) : checkFavicon(bytes);
  if (!checked.ok) throw new AppError(PROBLEM[checked.problem]);

  const size = 'size' in checked ? (checked.size as number) : undefined;
  const image: BrandImage = { mime: checked.mime, version: Date.now(), ...(size ? { size } : {}) };
  const path = brandObjectPath(kind, image);
  const up = await client.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType: checked.mime, upsert: false });
  if (up.error) throw new AppError('err_save_failed');

  const next: Brand = { ...current, [kind]: image };
  try {
    await writeBrand(client, next);
  } catch (e) {
    await client.storage.from(BUCKET).remove([path]); // keep the old image, drop the orphan
    throw e;
  }
  const old = current[kind];
  if (old) await client.storage.from(BUCKET).remove([brandObjectPath(kind, old)]);
  return next;
}

/** "Use the default": forget the reference first, then delete the file. */
export async function removeBrandImage(
  client: SupabaseClient,
  kind: BrandImageKind,
  current: Brand,
): Promise<Brand> {
  const old = current[kind];
  const next: Brand = { ...current };
  delete next[kind];
  await writeBrand(client, next);
  if (old) await client.storage.from(BUCKET).remove([brandObjectPath(kind, old)]);
  return next;
}
