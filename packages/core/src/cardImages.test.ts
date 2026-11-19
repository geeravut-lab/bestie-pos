import { describe, expect, it } from 'vitest';
import {
  cardImageUrl,
  cardImageUrls,
  cardObjectPath,
  checkCardImage,
  parseCardImages,
} from './cardImages';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('card images', () => {
  it('parses only well-formed entries', () => {
    expect(
      parseCardImages({
        sell: { mime: 'image/png', version: 5 },
        bad1: { mime: 'image/svg+xml', version: 1 },
        bad2: { mime: 'image/png', version: 'x' },
        'no way': { mime: 'image/png', version: 1 },
      }),
    ).toEqual({ sell: { mime: 'image/png', version: 5 } });
    expect(parseCardImages(null)).toEqual({});
    expect(parseCardImages([])).toEqual({});
  });
  it('checks the bytes, not the file name', () => {
    expect(checkCardImage(PNG)).toEqual({ ok: true, mime: 'image/png' });
    expect(checkCardImage(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toEqual({
      ok: false,
      problem: 'bad_type',
    });
    expect(checkCardImage(new Uint8Array(1024 * 1024 + 1))).toEqual({
      ok: false,
      problem: 'too_big',
    });
  });
  it('a new upload is a new file and a new URL', () => {
    const a = { mime: 'image/png' as const, version: 1 };
    const b = { mime: 'image/png' as const, version: 2 };
    expect(cardObjectPath('sell', a)).not.toBe(cardObjectPath('sell', b));
    expect(cardImageUrl('sell', b)).toBe('/api/card-image?id=sell&v=2');
    expect(cardImageUrl('sell', undefined)).toBeUndefined();
    expect(cardImageUrls({ sell: a })).toEqual({ sell: '/api/card-image?id=sell&v=1' });
  });
});
