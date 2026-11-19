import type { SupabaseClient } from '@supabase/supabase-js';
import { cardObjectPath, checkCardImage } from '@bestie/core';
import type { CardImage, CardImageProblem, CardImages } from '@bestie/core';
import { AppError } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';

const PROBLEM: Record<CardImageProblem, ErrorKey> = {
  too_big: 'err_brand_too_big',
  bad_type: 'err_brand_bad_type',
};
const BUCKET = 'card-images';

/** An UPDATE that touches no row is "success" to PostgREST, so count rows. */
async function write(client: SupabaseClient, next: CardImages): Promise<void> {
  const { data, error } = await client
    .from('platform_settings')
    .update({ card_images: next })
    .eq('id', true)
    .select('id');
  if (error || data?.length !== 1)
    throw new AppError(error?.code === '42501' ? 'err_forbidden' : 'err_save_failed');
}

/** Same order as the brand images: check bytes → upload the NEW versioned file → point the settings at it → delete the old file. */
export async function uploadCardImage(
  client: SupabaseClient,
  id: string,
  file: Blob,
  current: CardImages,
): Promise<CardImages> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const checked = checkCardImage(bytes);
  if (!checked.ok) throw new AppError(PROBLEM[checked.problem]);
  const image: CardImage = { mime: checked.mime, version: Date.now() };
  const path = cardObjectPath(id, image);
  const up = await client.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType: checked.mime, upsert: false });
  if (up.error) throw new AppError('err_save_failed');
  const next = { ...current, [id]: image };
  try {
    await write(client, next);
  } catch (e) {
    await client.storage.from(BUCKET).remove([path]);
    throw e;
  }
  const old = current[id];
  if (old) await client.storage.from(BUCKET).remove([cardObjectPath(id, old)]);
  return next;
}

/** "Use the built-in picture": forget the reference first, then delete the file. */
export async function removeCardImage(
  client: SupabaseClient,
  id: string,
  current: CardImages,
): Promise<CardImages> {
  const old = current[id];
  const next = { ...current };
  delete next[id];
  await write(client, next);
  if (old) await client.storage.from(BUCKET).remove([cardObjectPath(id, old)]);
  return next;
}
