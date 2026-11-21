/**
 * Texts the LINE bot sends back in chat. They live here (not in the app dictionary) because Vercel Functions cannot import
 * the workspace i18n package; a unit test makes sure both languages exist for every message.
 */
export type Lang = 'th' | 'en';

export const LINE_MESSAGES = {
  linked: {
    th: 'เชื่อมต่อ LINE กับบัญชีของคุณแล้ว ต่อไปนี้จะได้รับการแจ้งเตือนที่นี่',
    en: 'Your LINE is now connected. You will receive your notifications here.',
  },
  invalidCode: {
    th: 'รหัสไม่ถูกต้องหรือหมดอายุ กรุณาขอรหัสใหม่จากหน้าบัญชีในแอป',
    en: 'That code is not valid or has expired. Please request a new one from the Account page in the app.',
  },
  help: {
    th: 'หากต้องการเชื่อมต่อบัญชี ให้ส่งรหัส 8 ตัวที่แสดงในหน้าบัญชีของแอปมาที่นี่ หรือพิมพ์ "เกาะ" เพื่อดูร้านบนเกาะ',
    en: 'To connect your account, send the 8-character code shown on the Account page of the app. Or type "island" to browse the shops on the island.',
  },
  islandTitle: { th: 'ร้านบนเกาะ', en: 'Shops on the island' },
  islandBook: { th: 'จอง', en: 'Book' },
  islandOrder: { th: 'สั่งอาหาร', en: 'Order food' },
  islandMore: { th: 'ดูทั้งหมดและค้นหา', en: 'See all and search' },
  islandNone: { th: 'ยังไม่มีร้านในรายการ', en: 'No shops are listed yet.' },
  guestLinked: {
    th: 'ตั้งค่าเตือนนัดเรียบร้อยแล้ว เราจะส่งข้อความเตือนที่นี่ก่อนถึงเวลานัด',
    en: 'Your appointment reminder is set. We will message you here shortly before your appointment.',
  },
  guestReminder: {
    th: 'เตือนนัด',
    en: 'Appointment reminder',
  },
  guestReminderCancel: {
    th: 'ถ้าต้องการยกเลิก ใช้หน้าจองเดิมพร้อมรหัสจอง',
    en: 'To cancel, use your booking page with your booking code.',
  },
  testTitle: { th: 'ทดสอบการแจ้งเตือน', en: 'Test notification' },
  testSummary: { th: 'การแจ้งเตือนทาง LINE ใช้งานได้ปกติ', en: 'Your LINE notifications are working.' },
  openApp: { th: 'เปิดแอป', en: 'Open the app' },
} as const satisfies Record<string, Record<Lang, string>>;

/** The help text is sent to people we cannot identify yet, so it goes out in BOTH languages. */
export const helpBothLanguages = (): string =>
  `${LINE_MESSAGES.help.th}\n\n${LINE_MESSAGES.help.en}`;
