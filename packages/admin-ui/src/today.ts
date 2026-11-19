/** Today's date in Bangkok ("YYYY-MM-DD"), the business day the shop lives in. */
export function bangkokToday(now: number = Date.now()): string {
  const d = new Date(now + 7 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
