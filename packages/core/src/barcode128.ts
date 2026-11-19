// Code 128 (subset B): the barcode printed on price labels. Subset B covers every character a Bestie barcode may contain
// (letters in both cases, digits, dashes). The 107 symbol patterns are the ISO / IEC 15417 table (the same data every Code 128
// library carries); `1` = bar module, `0` = space module. The unit tests compare the output with a reference encoder.

const PATTERNS = [
  '11011001100',
  '11001101100',
  '11001100110',
  '10010011000',
  '10010001100',
  '10001001100',
  '10011001000',
  '10011000100',
  '10001100100',
  '11001001000',
  '11001000100',
  '11000100100',
  '10110011100',
  '10011011100',
  '10011001110',
  '10111001100',
  '10011101100',
  '10011100110',
  '11001110010',
  '11001011100',
  '11001001110',
  '11011100100',
  '11001110100',
  '11101101110',
  '11101001100',
  '11100101100',
  '11100100110',
  '11101100100',
  '11100110100',
  '11100110010',
  '11011011000',
  '11011000110',
  '11000110110',
  '10100011000',
  '10001011000',
  '10001000110',
  '10110001000',
  '10001101000',
  '10001100010',
  '11010001000',
  '11000101000',
  '11000100010',
  '10110111000',
  '10110001110',
  '10001101110',
  '10111011000',
  '10111000110',
  '10001110110',
  '11101110110',
  '11010001110',
  '11000101110',
  '11011101000',
  '11011100010',
  '11011101110',
  '11101011000',
  '11101000110',
  '11100010110',
  '11101101000',
  '11101100010',
  '11100011010',
  '11101111010',
  '11001000010',
  '11110001010',
  '10100110000',
  '10100001100',
  '10010110000',
  '10010000110',
  '10000101100',
  '10000100110',
  '10110010000',
  '10110000100',
  '10011010000',
  '10011000010',
  '10000110100',
  '10000110010',
  '11000010010',
  '11001010000',
  '11110111010',
  '11000010100',
  '10001111010',
  '10100111100',
  '10010111100',
  '10010011110',
  '10111100100',
  '10011110100',
  '10011110010',
  '11110100100',
  '11110010100',
  '11110010010',
  '11011011110',
  '11011110110',
  '11110110110',
  '10101111000',
  '10100011110',
  '10001011110',
  '10111101000',
  '10111100010',
  '11110101000',
  '11110100010',
  '10111011110',
  '10111101110',
  '11101011110',
  '11110101110',
  '11010000100',
  '11010010000',
  '11010011100',
  '1100011101011',
] as const;

const START_B = 104;
const STOP = 106;

/** Characters Code 128 B can carry: ASCII 32–126. */
export const code128BOk = (text: string): boolean => /^[\x20-\x7e]+$/.test(text);

/** The module string (`1` bar / `0` space) of `text` in Code 128 B: start, data, check symbol, stop. Throws on an unsupported character. */
export function code128B(text: string): string {
  if (!code128BOk(text)) throw new RangeError('Code 128 B carries printable ASCII only');
  let sum = START_B;
  let out = PATTERNS[START_B]!;
  for (let i = 0; i < text.length; i++) {
    const v = text.charCodeAt(i) - 32;
    sum += v * (i + 1);
    out += PATTERNS[v]!;
  }
  return out + PATTERNS[sum % 103]! + PATTERNS[STOP]!;
}

/** Bars as runs of modules: `{ x, w }` in module units (for drawing as rectangles). */
export function barRuns(modules: string): { x: number; w: number }[] {
  const runs: { x: number; w: number }[] = [];
  let start = -1;
  for (let i = 0; i <= modules.length; i++) {
    const bar = modules[i] === '1';
    if (bar && start < 0) start = i;
    if (!bar && start >= 0) {
      runs.push({ x: start, w: i - start });
      start = -1;
    }
  }
  return runs;
}
