/**
 * The one and only place user-facing strings live (I18N-KNOWLEDGE.md).
 *
 * - Thai is the source of truth. `en` must `satisfies Dict`, so a missing or extra key
 *   fails `pnpm typecheck`.
 * - Code writes `t.someKey`; never write text (including aria-label / alt / placeholder) in components.
 * - Servers return `err_*` codes, never sentences; screens turn them into text with `errorText`.
 * - The app name is written only here, so the branding feature can swap it later.
 * - Plain TypeScript, no React import — usable from functions, metadata and tests.
 */

export type Lang = 'th' | 'en';
export const LANGS: readonly Lang[] = ['th', 'en'];
export const DEFAULT_LANG: Lang = 'th';
export const LANG_STORAGE_KEY = 'bestie-lang';

const th = {
  // ── brand ────────────────────────────────────────────────────────────────
  appName: 'Bestie POS',
  appTagline: 'POS เพื่อนซี้ของร้านคุณ',

  // ── apps ─────────────────────────────────────────────────────────────────
  appPos: 'จุดขาย',
  appAdmin: 'หลังร้าน',
  appGuest: 'สำหรับลูกค้า',
  scaffoldTitle: 'กำลังสร้างระบบ',
  scaffoldBody: 'โครงระบบพร้อมแล้ว ฟีเจอร์ต่าง ๆ จะทยอยเปิดให้ใช้งานตามแผน Phase 1',
  scaffoldPhase: 'Phase 1 · ฐานระบบ',
  scaffoldDemoAction: 'ทดสอบปุ่มโหลด',
  scaffoldDemoDone: 'ปุ่มโหลดทำงานปกติ',

  // ── common ───────────────────────────────────────────────────────────────
  loading: 'กำลังดำเนินการ',
  langGroup: 'ภาษา',
  langTh: 'ไทย',
  langEn: 'English',
  skipToContent: 'ข้ามไปที่เนื้อหา',
  logoAlt: 'โลโก้ {name}',

  // ── errors (server returns the code, screens show the sentence) ──────────
  err_unknown: 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง',
  err_network: 'เชื่อมต่ออินเทอร์เน็ตไม่ได้ กรุณาลองใหม่เมื่อสัญญาณกลับมา',
  err_feature_off: 'ฟีเจอร์นี้ปิดใช้งานอยู่',
  err_forbidden: 'คุณไม่มีสิทธิ์ทำรายการนี้',
  err_invalid_input: 'ข้อมูลที่กรอกไม่ถูกต้อง',
  err_save_failed: 'บันทึกไม่สำเร็จ กรุณาลองใหม่',
};

export type Dict = { [K in keyof typeof th]: string };

const en = {
  appName: 'Bestie POS',
  appTagline: 'The bestie your shop deserves',

  appPos: 'Point of Sale',
  appAdmin: 'Back Office',
  appGuest: 'Guest',
  scaffoldTitle: 'Building the platform',
  scaffoldBody: 'The foundation is ready. Features will switch on step by step through Phase 1.',
  scaffoldPhase: 'Phase 1 · Foundation',
  scaffoldDemoAction: 'Try the loading button',
  scaffoldDemoDone: 'The loading button works',

  loading: 'Working on it',
  langGroup: 'Language',
  langTh: 'ไทย',
  langEn: 'English',
  skipToContent: 'Skip to content',
  logoAlt: '{name} logo',

  err_unknown: 'Something went wrong. Please try again.',
  err_network: "Can't reach the internet. Please try again when the signal is back.",
  err_feature_off: 'This feature is turned off.',
  err_forbidden: "You don't have permission to do this.",
  err_invalid_input: 'Some of the information is not valid.',
  err_save_failed: "Couldn't save. Please try again.",
} satisfies Dict;

export const dict: Record<Lang, Dict> = { th, en };

export const isLang = (v: unknown): v is Lang =>
  typeof v === 'string' && (LANGS as readonly string[]).includes(v);

/** Fill `{placeholder}`s; unknown placeholders are kept so a typo is visible instead of silent. */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

export type ErrorKey = Extract<keyof Dict, `err_${string}`>;

export const isErrorKey = (v: unknown): v is ErrorKey =>
  typeof v === 'string' && v.startsWith('err_') && v in th;

/** Unknown / missing codes degrade to the generic message. */
export const errorText = (code: unknown, t: Dict): string =>
  isErrorKey(code) ? t[code] : t.err_unknown;

/**
 * Throw this from any action / handler. Screens render `errorText(error.code, t)`.
 * Anything that is not an AppError degrades to `err_unknown` — never leak raw messages to users.
 */
export class AppError extends Error {
  readonly code: ErrorKey;
  constructor(code: ErrorKey) {
    super(code);
    this.name = 'AppError';
    this.code = code;
  }
}

export const toErrorCode = (e: unknown): ErrorKey => {
  if (e instanceof AppError) return e.code;
  if (e instanceof TypeError && /fetch|network/i.test(e.message)) return 'err_network';
  return 'err_unknown';
};
