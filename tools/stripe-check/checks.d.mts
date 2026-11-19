export type Level = 'ok' | 'fail' | 'warn' | 'info';
export type CheckResult = { id: string; level: Level; text: string };
export type Row = Record<string, unknown>;
export type Snap = Record<string, Row[]>;
export const REQUIRED_EVENTS: string[];
export const WEBHOOK_PATH: string;
export const STEPS: { id: string; title: string; wait: string; optional?: boolean }[];
export function checkPreflight(p: {
  secretKey?: string;
  account?: Row | null;
  webhooks?: Row[] | null;
  readers?: Row[] | null;
  siteUrl: string;
  health?: { ok: boolean; status?: number } | null;
}): CheckResult[];
export function gapsIn(
  receipts: { device_id?: string | null; number: string }[],
): { device: string; from: number; to: number }[];
export const CHECKS: Record<string, (snap: Snap) => CheckResult[]>;
export function checkPromptPay(snap: Snap): CheckResult[];
export function checkCancel(snap: Snap): CheckResult[];
export function checkCash(snap: Snap): CheckResult[];
export function checkMismatch(snap: Snap): CheckResult[];
export function checkCard(snap: Snap): CheckResult[];
export function checkGuest(snap: Snap): CheckResult[];
export function checkShares(snap: Snap): CheckResult[];
export function probeSql(since?: number): string;
export function summarize(results: CheckResult[]): Record<Level, number>;
export function render(results: CheckResult[]): string;
