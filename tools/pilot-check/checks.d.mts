export type Level = 'ok' | 'fail' | 'warn' | 'info';
export type CheckResult = { group: string; id: string; level: Level; text: string; shop?: string };
export type StoreSnapshot = Record<string, unknown> & { name: string; profile: string };
export const SNAPSHOT_SQL: string;
export const MANUAL_STEPS: string[];
export function checkStore(snap: StoreSnapshot): CheckResult[];
export function checkSystem(p: {
  auth: Record<string, unknown> | null;
  vercelEnvNames: string[] | null;
  siteUrl?: string;
}): CheckResult[];
export function summarize(results: CheckResult[]): Record<Level, number>;
export function render(results: CheckResult[], opts?: { quiet?: boolean }): string;
