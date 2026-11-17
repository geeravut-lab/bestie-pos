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

  // ── navigation (every nav item needs navX + hintX) ───────────────────────
  navMain: 'เมนูหลัก',
  navMore: 'เพิ่มเติม',
  navMoreClose: 'ปิด',
  navBackTo: 'กลับไป{page}',
  navDisabled: 'ปิดอยู่ในร้านนี้',
  navOpening: 'กำลังเปิดหน้า',
  navHome: 'หน้าแรก',
  navSell: 'ขาย',
  hintSell: 'เปิดบิลและรับชำระ',
  navTables: 'โต๊ะ',
  hintTables: 'ผังโต๊ะ ย้าย รวมโต๊ะ',
  navQueue: 'คิว',
  hintQueue: 'เรียกคิวลูกค้า',
  navOrders: 'ออเดอร์',
  hintOrders: 'ออเดอร์วันนี้',
  navCustomers: 'ลูกค้า',
  hintCustomers: 'สมาชิกและแต้ม',
  navShift: 'กะ',
  hintShift: 'เปิด-ปิดกะและนับเงิน',
  navReceipts: 'ใบเสร็จ',
  hintReceipts: 'ดูและพิมพ์ซ้ำ',
  navTakeOrder: 'สั่งอาหาร',
  hintTakeOrder: 'รับออเดอร์ที่โต๊ะ',
  navReady: 'พร้อมเสิร์ฟ',
  hintReady: 'จานที่ครัวทำเสร็จแล้ว',
  navKitchen: 'จอครัว',
  hintKitchen: 'ออเดอร์เข้าครัวและบาร์',
  navMenu: 'เมนู',
  hintMenu: 'รายการ ราคา ตัวเลือก',
  navStock: 'สต็อก',
  hintStock: 'ของเหลือและสั่งเพิ่ม',
  navStaff: 'พนักงาน',
  hintStaff: 'สิทธิ์และรหัส PIN',
  navReports: 'รายงาน',
  hintReports: 'ยอดขายและการชำระเงิน',
  navCredit: 'เครดิต',
  hintCredit: 'ยอดคงค้างและเติมเงิน',
  navPoints: 'แต้ม',
  hintPoints: 'แต้มสะสมของลูกค้า',
  navModules: 'โมดูล',
  hintModules: 'เปิดปิดฟีเจอร์ของร้าน',
  navDevices: 'อุปกรณ์',
  hintDevices: 'แท็บเล็ต เครื่องพิมพ์ POS ID',
  navDashboard: 'ภาพรวม',
  hintDashboard: 'ทุกสาขาในหน้าเดียว',
  navAi: 'ผู้ช่วย AI',
  hintAi: 'ถามเรื่องร้านของคุณ',
  navBranding: 'แบรนด์',
  hintBranding: 'โลโก้ ไอคอน ชื่อแอป',
  navFlags: 'สวิตช์ฟีเจอร์',
  hintFlags: 'เปิดปิดฟีเจอร์ทั้งระบบ',
  navAudit: 'Audit trail',
  hintAudit: 'ใครทำอะไรเมื่อไหร่',
  navAiSettings: 'ตั้งค่า AI',
  hintAiSettings: 'ผู้ให้บริการ โมเดล คำสั่ง',
  navLine: 'LINE',
  hintLine: 'แจ้งเตือนและการผูกบัญชี',
  navAnalytics: 'สถิติการใช้งาน',
  hintAnalytics: 'ใครใช้ฟีเจอร์ไหนบ้าง',
  navGuestMenu: 'เมนูและสั่งอาหาร',
  hintGuestMenu: 'ดูเมนูแล้วสั่งได้เลย',
  navPass: 'บัตรสมาชิก',
  hintPass: 'แต้มและสิทธิ์ของฉัน',
  navBook: 'จองคิว',
  hintBook: 'จองบริการล่วงหน้า',
  navPay: 'จ่ายเงิน',
  hintPay: 'สแกน PromptPay',

  // ── roles & home ─────────────────────────────────────────────────────────
  roleCashier: 'แคชเชียร์',
  roleWaiter: 'พนักงานเสิร์ฟ',
  roleKitchen: 'ครัวและบาร์',
  roleManager: 'ผู้จัดการ',
  roleOwner: 'เจ้าของร้าน',
  rolePlatformAdmin: 'ผู้ดูแลระบบ',
  roleGuest: 'ลูกค้า',
  homeGreeting: 'สวัสดี! วันนี้อยากทำอะไร',
  homePreviewLabel: 'ดูหน้าแรกของ',
  homePreviewNote: 'ตัวอย่างหน้าแรกตามบทบาท (ยังไม่ต้องล็อกอิน)',
  profileLabel: 'ประเภทร้าน',
  profileRestaurant: 'ร้านอาหาร',
  profileCafe: 'คาเฟ่',
  scrollDown: 'เลื่อนลง',
  scrollUp: 'กลับขึ้นบน',
  pageSoonTitle: 'หน้านี้กำลังสร้าง',
  pageSoonBody: 'เมนูนี้จะเปิดให้ใช้งานเร็ว ๆ นี้ตามแผนงาน',
  cardImageAlt: 'ภาพประกอบเมนู {name}',

  // ── auth, onboarding, account ────────────────────────────────────────────
  navAccount: 'บัญชี',
  authTitleSignIn: 'เข้าสู่ระบบ',
  authTitleSignUp: 'สมัครใช้งาน',
  authEmail: 'อีเมล',
  authPassword: 'รหัสผ่าน',
  authPasswordHint: 'อย่างน้อย 8 ตัวอักษร',
  authShowPassword: 'แสดงรหัสผ่าน',
  authHidePassword: 'ซ่อนรหัสผ่าน',
  authSignIn: 'เข้าสู่ระบบ',
  authSignUp: 'สมัครใช้งาน',
  authSwitchToSignUp: 'ยังไม่มีบัญชี? สมัครใช้งาน',
  authSwitchToSignIn: 'มีบัญชีแล้ว? เข้าสู่ระบบ',
  authOr: 'หรือ',
  authGoogle: 'เข้าสู่ระบบด้วย Google',
  authLine: 'เข้าสู่ระบบด้วย LINE (Aivora)',
  authCheckEmail: 'ส่งลิงก์ยืนยันไปที่อีเมลของคุณแล้ว กรุณากดลิงก์เพื่อเปิดบัญชี',
  authSignOut: 'ออกจากระบบ',
  appLoading: 'กำลังโหลดข้อมูลร้าน',
  retry: 'ลองใหม่',
  onboardingTitle: 'เปิดร้านของคุณ',
  onboardingBody: 'บอกชื่อธุรกิจและเลือกประเภทร้าน ปรับเปลี่ยนได้ภายหลัง',
  onboardingOrgName: 'ชื่อธุรกิจ / บริษัท',
  onboardingStoreName: 'ชื่อร้าน (สาขา)',
  onboardingProfile: 'ประเภทร้าน',
  onboardingCreate: 'สร้างร้าน',
  onboardingSoon: 'เร็ว ๆ นี้',
  profileSalon: 'ร้านทำผม / เสริมสวย',
  profileSpa: 'นวด / สปา',
  profileResort: 'รีสอร์ท',
  profileRetail: 'ร้านค้าปลีก',
  profileTours: 'ทัวร์ / เช่า',
  accountTitle: 'บัญชีของฉัน',
  accountSignedInAs: 'เข้าสู่ระบบเป็น',
  pwTitle: 'เปลี่ยนรหัสผ่าน',
  pwCurrent: 'รหัสผ่านปัจจุบัน',
  pwNew: 'รหัสผ่านใหม่',
  pwConfirm: 'ยืนยันรหัสผ่านใหม่',
  pwSave: 'เปลี่ยนรหัสผ่าน',
  pwDone: 'เปลี่ยนรหัสผ่านแล้ว อุปกรณ์อื่นถูกออกจากระบบ',
  pwNotAvailable: 'บัญชีนี้เข้าสู่ระบบด้วย Google หรือ LINE จึงไม่มีรหัสผ่านให้เปลี่ยน',
  ssoWorking: 'กำลังเข้าสู่ระบบด้วย LINE',
  ssoFailedTitle: 'เข้าสู่ระบบด้วย LINE ไม่สำเร็จ',
  ssoBack: 'กลับไปหน้าเข้าสู่ระบบ',

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
  err_auth_invalid: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
  err_auth_exists: 'อีเมลนี้มีบัญชีอยู่แล้ว',
  err_auth_email_unconfirmed: 'ยังไม่ได้ยืนยันอีเมล กรุณากดลิงก์ในอีเมลก่อน',
  err_weak_password: 'รหัสผ่านสั้นเกินไป (อย่างน้อย 8 ตัวอักษร)',
  err_password_long: 'รหัสผ่านยาวเกินไป (ไม่เกิน 72 ตัวอักษร)',
  err_password_current_wrong: 'รหัสผ่านปัจจุบันไม่ถูกต้อง',
  err_password_mismatch: 'รหัสผ่านใหม่สองช่องไม่ตรงกัน',
  err_password_same: 'รหัสผ่านใหม่ต้องไม่เหมือนรหัสผ่านเดิม',
  err_rate_limited: 'ลองบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่',
  err_provider_disabled: 'ยังไม่เปิดใช้การเข้าสู่ระบบแบบนี้',
  err_sso_invalid_ticket: 'ลิงก์เข้าสู่ระบบหมดอายุหรือถูกใช้ไปแล้ว กรุณาเริ่มใหม่จากหน้า Launcher',
  err_sso_failed: 'เข้าสู่ระบบด้วย LINE ไม่สำเร็จ กรุณาลองใหม่',
  err_sso_timeout: 'ใช้เวลานานเกินไป กรุณาลองใหม่',
  err_load_failed: 'โหลดข้อมูลไม่สำเร็จ',
};

export type Dict = { [K in keyof typeof th]: string };

const en = {
  appName: 'Bestie POS',
  appTagline: 'The bestie your shop deserves',

  appPos: 'Point of Sale',
  appAdmin: 'Back Office',
  appGuest: 'Guest',

  navMain: 'Main menu',
  navMore: 'More',
  navMoreClose: 'Close',
  navBackTo: 'Back to {page}',
  navDisabled: 'Off for this store',
  navOpening: 'Opening page',
  navHome: 'Home',
  navSell: 'Sell',
  hintSell: 'Open a bill and take payment',
  navTables: 'Tables',
  hintTables: 'Floor plan, move & merge',
  navQueue: 'Queue',
  hintQueue: "Call customers' numbers",
  navOrders: 'Orders',
  hintOrders: "Today's orders",
  navCustomers: 'Customers',
  hintCustomers: 'Members & points',
  navShift: 'Shift',
  hintShift: 'Open, close & count cash',
  navReceipts: 'Receipts',
  hintReceipts: 'View & reprint',
  navTakeOrder: 'Take order',
  hintTakeOrder: 'Order at the table',
  navReady: 'Ready',
  hintReady: 'Dishes the kitchen finished',
  navKitchen: 'Kitchen',
  hintKitchen: 'Orders for kitchen & bar',
  navMenu: 'Menu',
  hintMenu: 'Items, prices, options',
  navStock: 'Stock',
  hintStock: "What's left & reorder",
  navStaff: 'Staff',
  hintStaff: 'Roles & PIN codes',
  navReports: 'Reports',
  hintReports: 'Sales & payments',
  navCredit: 'Credit',
  hintCredit: 'Balances & top-ups',
  navPoints: 'Points',
  hintPoints: 'Customer rewards',
  navModules: 'Modules',
  hintModules: 'Switch store features',
  navDevices: 'Devices',
  hintDevices: 'Tablets, printers, POS ID',
  navDashboard: 'Overview',
  hintDashboard: 'All stores at a glance',
  navAi: 'AI assistant',
  hintAi: 'Ask about your shop',
  navBranding: 'Branding',
  hintBranding: 'Logo, icons, app name',
  navFlags: 'Feature switches',
  hintFlags: 'Turn features on/off platform-wide',
  navAudit: 'Audit trail',
  hintAudit: 'Who did what, when',
  navAiSettings: 'AI settings',
  hintAiSettings: 'Providers, models, prompts',
  navLine: 'LINE',
  hintLine: 'Notifications & linking',
  navAnalytics: 'Usage',
  hintAnalytics: 'Which features get used',
  navGuestMenu: 'Menu & order',
  hintGuestMenu: 'Browse and order',
  navPass: 'My pass',
  hintPass: 'My points & perks',
  navBook: 'Book',
  hintBook: 'Book a service ahead',
  navPay: 'Pay',
  hintPay: 'Scan PromptPay',

  roleCashier: 'Cashier',
  roleWaiter: 'Waiter',
  roleKitchen: 'Kitchen & bar',
  roleManager: 'Manager',
  roleOwner: 'Owner',
  rolePlatformAdmin: 'Platform admin',
  roleGuest: 'Guest',
  homeGreeting: 'Hi! What shall we do today?',
  homePreviewLabel: 'Preview home as',
  homePreviewNote: 'Role home preview (no sign-in yet)',
  profileLabel: 'Store type',
  profileRestaurant: 'Restaurant',
  profileCafe: 'Cafe',
  scrollDown: 'Scroll down',
  scrollUp: 'Back to top',
  pageSoonTitle: 'This page is being built',
  pageSoonBody: 'This section opens soon, following the plan.',
  cardImageAlt: 'Illustration for {name}',

  navAccount: 'Account',
  authTitleSignIn: 'Sign in',
  authTitleSignUp: 'Create your account',
  authEmail: 'Email',
  authPassword: 'Password',
  authPasswordHint: 'At least 8 characters',
  authShowPassword: 'Show password',
  authHidePassword: 'Hide password',
  authSignIn: 'Sign in',
  authSignUp: 'Sign up',
  authSwitchToSignUp: 'No account yet? Sign up',
  authSwitchToSignIn: 'Already have an account? Sign in',
  authOr: 'or',
  authGoogle: 'Continue with Google',
  authLine: 'Sign in with LINE (Aivora)',
  authCheckEmail: 'We sent a confirmation link to your email. Open it to activate your account.',
  authSignOut: 'Sign out',
  appLoading: 'Loading your shop',
  retry: 'Try again',
  onboardingTitle: 'Set up your shop',
  onboardingBody: 'Tell us your business name and pick a store type. You can change it later.',
  onboardingOrgName: 'Business name',
  onboardingStoreName: 'Shop name (branch)',
  onboardingProfile: 'Store type',
  onboardingCreate: 'Create shop',
  onboardingSoon: 'Coming soon',
  profileSalon: 'Salon / barber',
  profileSpa: 'Massage / spa',
  profileResort: 'Resort',
  profileRetail: 'Retail',
  profileTours: 'Tours / rentals',
  accountTitle: 'My account',
  accountSignedInAs: 'Signed in as',
  pwTitle: 'Change password',
  pwCurrent: 'Current password',
  pwNew: 'New password',
  pwConfirm: 'Confirm new password',
  pwSave: 'Change password',
  pwDone: 'Password changed. Other devices were signed out.',
  pwNotAvailable: 'This account signs in with Google or LINE, so there is no password to change.',
  ssoWorking: 'Signing you in with LINE',
  ssoFailedTitle: 'LINE sign-in did not work',
  ssoBack: 'Back to sign in',

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
  err_auth_invalid: 'Wrong email or password.',
  err_auth_exists: 'An account with this email already exists.',
  err_auth_email_unconfirmed: 'Please confirm your email first (open the link we sent).',
  err_weak_password: 'Password is too short (at least 8 characters).',
  err_password_long: 'Password is too long (72 characters at most).',
  err_password_current_wrong: 'The current password is not correct.',
  err_password_mismatch: 'The two new passwords do not match.',
  err_password_same: 'The new password must differ from the current one.',
  err_rate_limited: 'Too many attempts. Please wait a moment and try again.',
  err_provider_disabled: 'This sign-in method is not enabled yet.',
  err_sso_invalid_ticket:
    'The sign-in link expired or was already used. Please start again from the Launcher.',
  err_sso_failed: 'LINE sign-in did not work. Please try again.',
  err_sso_timeout: 'This took too long. Please try again.',
  err_load_failed: 'Could not load the data.',
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
