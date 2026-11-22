// Builds docs/TEST-ACCOUNTS.pdf — every demo user, its role and what to test with it (Thai).
// The list was read from the demo database (staff + roles); keep it in step with tools/demo-data.
// Run: node tools/accounts-guide/build.mjs   (needs Playwright's Chromium)
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const require = createRequire(import.meta.url);
const fontDir = join(
  root,
  'node_modules/.pnpm/@fontsource-variable+noto-sans-thai@5.3.0/node_modules/@fontsource-variable/noto-sans-thai/files',
);
const b64 = (p) => readFileSync(p).toString('base64');
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
const DOMAIN = '@bestiedemo.example';

const COMPANY1 = '[DEMO] Island Group Co., Ltd.';
const COMPANY2 = '[DEMO] Palm Beach Co';

// [user, lock-screen name, role, scope, device, screen, flows, what to do]
const ACCOUNTS = [
  // ── Island Group — whole group
  [
    'owner.demo',
    'Demo Owner (เจ้าของกลุ่ม)',
    'เจ้าของ',
    'ทุกร้านของ Island Group',
    '—',
    'คอมพิวเตอร์ / แท็บเล็ต',
    'T01 T13 T14 T15 T19 T29 T30 T31 T33',
    'ตั้งค่าทั้งหมด: โมดูล เมนู บิลและแต้ม ทีมงานและบทบาท PIN เครื่อง รายงานทั้งกลุ่ม ส่งออกข้อมูล Audit เครือข่ายเกาะ ศูนย์เชื่อมต่อ',
  ],
  [
    'manager.demo',
    'Demo Manager',
    'ผู้จัดการ',
    'ทุกร้านของ Island Group',
    '(ใช้บนเครื่องของร้านที่เลือก)',
    'แท็บเล็ต',
    'T03 T09 T10 T11 T14 T17 T20 T22',
    'อนุมัติส่วนลดและยกเลิกด้วย PIN คืนเงิน รายงาน ทีมงาน ตัดสินมัดจำที่ค้าง (เก็บเป็นค่าปรับหรือคืน) ปิดกะ',
  ],
  [
    'accountant.demo',
    'Demo Accountant',
    'นักบัญชี (บทบาทกำหนดเอง)',
    'ทุกร้านของ Island Group',
    '—',
    'คอมพิวเตอร์',
    'T15 T19',
    'ดูรายงาน ลูกค้า Audit สต็อก/ต้นทุน อย่างเดียว ลองกดสิ่งที่ไม่มีสิทธิ์เพื่อดูว่าถูกปฏิเสธ',
  ],
  [
    'stockkeeper.demo',
    'Demo Stock keeper',
    'ผู้ดูแลสต็อก (บทบาทกำหนดเอง)',
    'ทุกร้านของ Island Group',
    '—',
    'แท็บเล็ต / มือถือ',
    'T16',
    'รับเข้า ของเสีย นับสต็อก ใบสั่งซื้อ โอนระหว่างร้าน ล็อตและวันหมดอายุ ไม่เห็นรายงานยอดขาย',
  ],
  // ── Island Kitchen
  [
    'cashier.kitchen.demo',
    'Demo Cashier (Kitchen)',
    'แคชเชียร์',
    'Island Kitchen',
    'Counter 1',
    'แท็บเล็ต',
    'T02 T04 T06 T09 T11 T12 T18 T29',
    'เปิดโต๊ะ/ขาย รับเงินทุกแบบ แยก/รวมบิล ใช้แต้มและ Credit ดีลิเวอรี ทดสอบออฟไลน์',
  ],
  [
    'waiter.kitchen.demo',
    'Demo Waiter (Kitchen)',
    'พนักงานเสิร์ฟ',
    'Island Kitchen',
    'Waiter handheld',
    'มือถือ / แท็บเล็ตเล็ก',
    'T04 T08 T18',
    'รับออเดอร์ที่โต๊ะ ส่งครัว ตอบ "เรียกพนักงาน" ของแขก กดเสิร์ฟแล้ว คิวรอโต๊ะ',
  ],
  [
    'kds.kitchen.demo',
    'Demo Kitchen screen',
    'ครัว',
    'Island Kitchen · สถานีครัว',
    'Kitchen screen',
    'แท็บเล็ตหรือจอครัว',
    'T04 T08 T17',
    'จอครัว: ดูตั๋ว กด พร้อม/เลิกทำ เห็นสีตามเวลารอ ไม่เห็นราคา',
  ],
  [
    'bar.kitchen.demo',
    'Demo Bar screen',
    'ครัว (สถานีบาร์)',
    'Island Kitchen · สถานีบาร์',
    'Bar screen',
    'แท็บเล็ตหรือจอบาร์',
    'T04',
    'จอบาร์: เห็นเฉพาะรายการเครื่องดื่ม',
  ],
  // ── Breeze Café
  [
    'cashier.cafe.demo',
    'Demo Cashier (Café)',
    'แคชเชียร์',
    'Breeze Café',
    'Café counter',
    'แท็บเล็ต',
    'T03 T05 T09 T11 T29 T31',
    'ออเดอร์หน้าร้านและเลขคิว ตู้สั่งเอง/สั่งออนไลน์ บัตรสะสมและพาส ส่วนลดด้วย PIN เติม Credit',
  ],
  [
    'kds.cafe.demo',
    'Demo Barista screen',
    'ครัว (บาริสต้า)',
    'Breeze Café',
    'Barista screen',
    'แท็บเล็ตหรือจอ',
    'T05',
    'จอบาริสต้า: กด พร้อม แล้วเลขคิวขึ้นจอเรียกคิว',
  ],
  // ── Sunset Salon / Lotus Spa
  [
    'reception.salon.demo',
    'Demo Reception (Salon)',
    'แคชเชียร์ / ต้อนรับ',
    'Sunset Salon',
    'Front desk',
    'แท็บเล็ต',
    'T20 T21 T23',
    'ปฏิทินนัดหมาย จองจากคอลัมน์ รับมัดจำ เปลี่ยนสถานะ เปิดบิล จ่ายเงิน สูตรสี ลิงก์จองออนไลน์',
  ],
  [
    'stylist.salon.demo',
    'Demo Stylist (Salon)',
    'ช่าง/หมอนวด (บทบาทกำหนดเอง)',
    'Sunset Salon',
    '—',
    'มือถือ',
    'T20',
    'เห็นคิวของตัวเอง สร้างนัดได้ (สิทธิ์สั่งและดูลูกค้า) รับแจ้งเตือนนัดออนไลน์',
  ],
  [
    'reception.spa.demo',
    'Demo Reception (Spa)',
    'แคชเชียร์ / ต้อนรับ',
    'Lotus Spa',
    'Front desk',
    'แท็บเล็ต',
    'T22 T23',
    'ปฏิทินห้อง/เตียง แพ็กเกจและคอร์ส ฟอร์มสุขภาพ มัดจำและทิป',
  ],
  [
    'therapist.spa.demo',
    'Demo Therapist (Spa)',
    'ช่าง/หมอนวด (บทบาทกำหนดเอง)',
    'Lotus Spa',
    '—',
    'มือถือ',
    'T22',
    'เห็นคิวและฟอร์มสุขภาพของลูกค้าที่จะรับ',
  ],
  // ── retail / tours / karaoke / resort
  [
    'cashier.retail.demo',
    'Demo Cashier (Mart)',
    'แคชเชียร์',
    'Island Mart',
    'Mart counter',
    'แท็บเล็ต',
    'T10 T24',
    'สแกนบาร์โค้ดและไซซ์ ขาย ใบเสร็จ (ไม่มีสิทธิ์คืนเงิน ต้องให้ผู้จัดการ)',
  ],
  [
    'manager.retail.demo',
    'Demo Manager (Mart)',
    'ผู้จัดการ',
    'Island Mart',
    '(ใช้บนเครื่อง Mart counter)',
    'แท็บเล็ต',
    'T10 T24',
    'คืนสินค้า (เงินสด/Credit) ใบคืน ป้ายราคา ใบนับสต็อก',
  ],
  [
    'cashier.tours.demo',
    'Demo Cashier (Tours)',
    'แคชเชียร์',
    'Island Tours',
    'Tour desk',
    'แท็บเล็ต',
    'T25 T26',
    'จองที่เคาน์เตอร์ รับมัดจำเงินสดเข้าลิ้นชัก เช็กอิน เปิดบิลทัวร์ (กะเปิดอยู่)',
  ],
  [
    'guide.tours.demo',
    'Demo Guide (Tours)',
    'พนักงานเสิร์ฟ (ไกด์)',
    'Island Tours',
    '—',
    'มือถือ',
    'T25',
    'ดูรายชื่อผู้ร่วมทริปและช่วยเช็กอิน',
  ],
  [
    'cashier.karaoke.demo',
    'Demo Cashier (Karaoke)',
    'แคชเชียร์',
    'Sing Along',
    'Karaoke desk',
    'แท็บเล็ต',
    'T27',
    'เริ่ม/พัก/หยุดห้อง แพ็กเกจ บิลเวลา รับมัดจำการจองห้อง คิวเพลง',
  ],
  [
    'manager.karaoke.demo',
    'Demo Manager (Karaoke)',
    'ผู้จัดการ',
    'Sing Along',
    '(ใช้บนเครื่อง Karaoke desk)',
    'แท็บเล็ต',
    'T27',
    'ตัดสินมัดจำของการจองที่ยกเลิก/ไม่มา ตั้งห้อง แพ็กเกจ ลิงก์จองห้อง',
  ],
  [
    'reception.resort.demo',
    'Demo Reception (Resort)',
    'แคชเชียร์ / ต้อนรับ',
    'Palm Resort',
    'Front desk',
    'แท็บเล็ต',
    'T28',
    'เช็กอิน/เอาต์ โฟลิโอ ลงบิลเข้าห้อง ค่าห้องรายคืน ใบสรุป (กะเปิดอยู่)',
  ],
  [
    'manager.resort.demo',
    'Demo Manager (Resort)',
    'ผู้จัดการ',
    'Palm Resort',
    '(ใช้บนเครื่อง Front desk)',
    'แท็บเล็ต',
    'T28',
    'ปรับรายการในโฟลิโอที่เปิดอยู่ คืนบิลที่ลงห้อง',
  ],
];
const BEACH = [
  [
    'owner.beach.demo',
    'Demo Owner – Palm Beach',
    'เจ้าของ',
    'ทุกร้านของ Palm Beach Co',
    '—',
    'คอมพิวเตอร์ / แท็บเล็ต',
    'T30',
    'อีกบริษัทหนึ่งในเครือข่ายเกาะ: ดูใบเคลียร์ริ่งฝั่งนี้ ตลาดเกาะ ยืนยันว่า Credit ของ Island Group ใช้ที่นี่ไม่ได้',
  ],
  [
    'cashier.beach.demo',
    'Demo Cashier (Palm Beach)',
    'แคชเชียร์',
    'Palm Beach Café',
    'Beach counter',
    'แท็บเล็ต',
    'T30',
    'ใช้แต้มของบัตรนักท่องเที่ยวที่ได้จากอีกบริษัท ดูว่ายอด Credit เป็น 0',
  ],
];

const ROLES = [
  [
    'เจ้าของ',
    'ทุกสิทธิ์ของบริษัท เปิด/ปิดโมดูล ตั้งค่า ทีมงานและบทบาท ปรับยอด Credit/แต้ม Audit',
    'หน้าของผู้ดูแลแพลตฟอร์ม (สวิตช์ฟีเจอร์ สถิติ ตั้งค่า AI/LINE ระดับระบบ)',
  ],
  [
    'ผู้จัดการ',
    'สั่ง/รับเงิน/กะ ยกเลิกรายการที่ส่งแล้ว ส่วนลดด้วย PIN คืนเงิน แก้เมนู จัดการทีม รายงาน Audit สต็อก ลิ้นชักเงิน',
    'ตั้งค่าบริษัทบางหน้า ศูนย์เชื่อมต่อ งบ AI ปรับยอด Credit/แต้ม',
  ],
  [
    'แคชเชียร์',
    'สั่ง รับเงินทุกแบบ เปิด/ปิดกะ ลิ้นชักเงิน ดูและสร้างสมาชิก',
    'ยกเลิก/ส่วนลด/คืนเงิน (ต้องขอ PIN ผู้จัดการ) แก้เมนู รายงาน',
  ],
  ['พนักงานเสิร์ฟ', 'สร้าง/แก้ออเดอร์ ส่งครัว นัดหมายและทัวร์ ดูลูกค้า', 'รับเงิน เปิดกะ ยกเลิก/ส่วนลด รายงาน'],
  ['ครัว', 'ใช้จอครัวเท่านั้น (สิทธิ์ kds.use) และตอกบัตร', 'ทุกอย่างอื่น ไม่เห็นราคา'],
  ['นักบัญชี (กำหนดเอง)', 'รายงาน ลูกค้า Audit trail สต็อก (ดูอย่างเดียว)', 'ขาย รับเงิน แก้ข้อมูล'],
  ['ผู้ดูแลสต็อก (กำหนดเอง)', 'จัดการสต็อกทั้งหมด ดูลูกค้า', 'ขาย รายงานยอดขาย'],
  ['ช่าง/หมอนวด (กำหนดเอง)', 'สร้างนัดหมาย ดูลูกค้า (สิทธิ์เดียวกับพนักงานเสิร์ฟ)', 'รับเงิน รายงาน'],
];

const FLOWS = [
  ['T01–T03', 'เข้าสู่ระบบ ตั้งเครื่อง POS เปิด/ปิดกะ', 'cashier.kitchen · cashier.cafe · manager · owner'],
  [
    'T04–T06',
    'ร้านอาหาร คาเฟ่ แยก/รวมบิล',
    'waiter.kitchen · kds.kitchen · bar.kitchen · cashier.kitchen · cashier.cafe · kds.cafe',
  ],
  ['T08', 'แขกสั่งผ่าน QR', 'ลิงก์ QR โต๊ะ (ไม่ต้องล็อกอิน) + waiter.kitchen · kds.kitchen'],
  [
    'T09–T11',
    'ส่วนลด แต้ม ยกเลิก/คืน สมาชิก Credit',
    'cashier.cafe · cashier.kitchen · manager.demo · manager.retail',
  ],
  ['T12', 'ออฟไลน์', 'cashier.kitchen (ปิดเน็ตบนเครื่อง)'],
  ['T13–T15, T19', 'ตั้งค่า ทีม รายงาน Audit', 'owner.demo · manager.demo · accountant.demo'],
  [
    'T16–T18',
    'สต็อก ตอกบัตร คิวรอโต๊ะ',
    'stockkeeper · manager · cashier.kitchen · kds.kitchen · waiter.kitchen',
  ],
  [
    'T20–T23',
    'ซาลอนและสปา',
    'reception.salon · stylist.salon · reception.spa · therapist.spa · manager.demo',
  ],
  ['T24', 'ค้าปลีกและคืนสินค้า', 'cashier.retail · manager.retail'],
  ['T25–T26', 'ทัวร์', 'cashier.tours · guide.tours · manager.demo'],
  ['T27', 'คาราโอเกะ', 'cashier.karaoke · manager.karaoke'],
  ['T28', 'รีสอร์ตและโฟลิโอ', 'reception.resort · manager.resort · cashier.kitchen (ชาร์จบิลเข้าห้อง)'],
  [
    'T29, T31',
    'ดีลิเวอรี คีออสก์ บัตรสะสม LINE ศูนย์เชื่อมต่อ',
    'cashier.kitchen · cashier.cafe · owner.demo',
  ],
  ['T30', 'เครือข่ายเกาะ สองบริษัท', 'owner.demo · owner.beach · cashier.cafe · cashier.beach'],
  ['T32', 'ผู้ดูแลแพลตฟอร์ม', 'ใช้บัญชีของเจ้าของระบบที่ได้รับสิทธิ์ (ไม่มีบัญชีเดโมใดเป็น)'],
  ['T33–T34', 'ผู้ช่วย AI มือถือ การเข้าถึง', 'owner.demo · manager.demo · ทุกบัญชีบนมือถือ'],
];

const acctRows = (list) =>
  list
    .map(
      (a) =>
        `<tr><td class="em"><b>${esc(a[0])}</b><br><span class="dom">${DOMAIN}</span></td><td>${esc(a[1])}</td><td class="role">${esc(a[2])}</td><td>${esc(a[3])}<br><span class="dev">เครื่อง: ${esc(a[4])} · ${esc(a[5])}</span></td><td class="fl">${esc(a[6])}</td><td>${esc(a[7])}</td></tr>`,
    )
    .join('');
const head =
  '<thead><tr><th>ผู้ใช้ (อีเมล)</th><th>ชื่อที่เห็นบนจอ "ใครกำลังใช้งาน?"</th><th>บทบาท</th><th>ขอบเขต / เครื่อง</th><th>flow ทดสอบ</th><th>ใช้ทำอะไร</th></tr></thead>';

const css = `
@font-face{font-family:'NST';src:url(data:font/woff2;base64,${b64(join(fontDir, 'noto-sans-thai-thai-wght-normal.woff2'))}) format('woff2');font-weight:100 900;unicode-range:U+0E01-0E5B,U+200C-200D,U+25CC}
@font-face{font-family:'NST';src:url(data:font/woff2;base64,${b64(join(fontDir, 'noto-sans-thai-latin-wght-normal.woff2'))}) format('woff2');font-weight:100 900;unicode-range:U+0000-00FF,U+2000-206F,U+2190-21FF,U+25A0-25FF}
@page{size:A4 landscape;margin:12mm 11mm 14mm}
:root{--p:#00796f;--ink:#0f2d4a;--bg:#f3fbfb;--acc:#ff7a59}
*{box-sizing:border-box}body{font-family:'NST','Noto Sans Thai',sans-serif;color:var(--ink);font-size:9.4pt;line-height:1.5;margin:0}
h1{font-size:17pt;margin:0 0 6pt;color:var(--p);border-bottom:3pt solid var(--acc);padding-bottom:4pt}h2{font-size:12pt;margin:12pt 0 4pt;color:var(--p)}p{margin:3pt 0}
.cover{height:182mm;display:flex;flex-direction:column;justify-content:center;border-left:7mm solid var(--p);padding:0 12mm;background:linear-gradient(160deg,#e3f7f4,#fff 62%);page-break-after:always}
.cover h1{font-size:30pt;border:0}.cover .sub{font-size:13pt;margin-bottom:14pt}.box{background:#fff;border:1px solid #cfe9e6;border-radius:7pt;padding:8pt 11pt;margin-top:8pt}
table{border-collapse:collapse;width:100%;margin:5pt 0}th,td{border:1px solid #cfdcdc;padding:3pt 5pt;vertical-align:top;font-size:8.4pt}th{background:var(--p);color:#fff;text-align:left}tr{page-break-inside:avoid}
td.em{width:120pt;word-break:break-all}.dom{color:#6b7f90;font-size:7.4pt}.role{font-weight:700;width:72pt}.dev{color:#5a6f80;font-size:7.8pt}.fl{width:72pt;color:var(--p);font-weight:600}
.co{background:var(--bg);font-weight:700;color:var(--p)}.note{background:#fff6e0;border:1px solid #f1d28a;border-left:3pt solid #e8a400;border-radius:4pt;padding:5pt 8pt;margin:6pt 0}
.steps{display:flex;gap:8pt}.steps div{flex:1;border:1px solid #cfe9e6;border-radius:7pt;padding:7pt 9pt;background:#fff}.steps b{color:var(--acc);font-size:13pt}
.pg{page-break-before:always}
`;
const html = `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>รายชื่อผู้ใช้ทดสอบ Bestie POS</title><style>${css}</style></head><body>
<div class="cover"><h1>รายชื่อผู้ใช้ทดสอบ Bestie POS</h1><div class="sub">ผู้ใช้และบทบาทของทีมทดสอบ ครบทุก flow · ${ACCOUNTS.length + BEACH.length} บัญชี · 2 บริษัทตัวอย่าง · 9 ร้าน</div>
<div class="box"><b>ทุกบัญชีเป็นข้อมูลทดสอบ</b> ลบได้ทั้งหมดก่อนเปิดใช้งานจริงด้วย <code>node tools/demo-data/run.mjs remote cleanup --yes</code> ห้ามใส่ข้อมูลลูกค้าจริง</div>
<div class="box">เอกสารนี้ไม่พิมพ์รหัสผ่าน: รหัสผ่านของบัญชีเดโมคือรหัสที่เจ้าของระบบตั้งไว้ตอนสร้างเดโม (ถามเจ้าของระบบ)</div></div>

<h1>1 · วิธีเข้าใช้ (3 ขั้น)</h1>
<div class="steps"><div><b>1</b><br><b>ล็อกอินบัญชีของเครื่อง</b><br>เปิด https://bestie-pos.vercel.app/ ใส่อีเมลของผู้ใช้ (เช่น cashier.kitchen.demo${DOMAIN}) และรหัสผ่านเดโม บัญชีเจ้าของ/ผู้จัดการ/นักบัญชีเข้าได้ทั้งบนคอมพิวเตอร์และแท็บเล็ต</div>
<div><b>2</b><br><b>เลือกว่าใครใช้งาน</b><br>เครื่อง POS ที่ผูกกับร้านแล้วจะขึ้น "ใครกำลังใช้งาน?" ให้แตะชื่อตามคอลัมน์ "ชื่อที่เห็นบนจอ" (แตะชื่อของตัวเองหรือคนที่จะทดสอบ)</div>
<div><b>3</b><br><b>ใส่ PIN</b><br>PIN ของทุกคนในเดโมคือ <b>1234</b> (บัญชีเจ้าของ Palm Beach ยังไม่มี PIN) 5 ครั้งผิดล็อก 15 นาที ถ้าเครื่องไม่ผูกร้าน ให้ผู้ดูแลกด "ใช้แท็บเล็ตนี้เป็นเครื่อง…" ที่เมนู เครื่องของร้าน</div></div>
<div class="note"><b>ข้อควรรู้ก่อนทดสอบ:</b> (1) แคชเชียร์/ครัว/เสิร์ฟ ใช้ "บัญชีของเครื่อง" ผูกกับร้านเดียว ส่วนเจ้าของ/ผู้จัดการ/นักบัญชี/ผู้ดูแลสต็อก เห็นทุกร้านของบริษัท (2) <b>Credit ใช้ข้ามร้านได้เฉพาะในบริษัทเดียวกัน</b> Island Group ↔ Palm Beach Co ใช้ Credit ร่วมกันไม่ได้ แต้มใช้ร่วมกันได้ (3) บัญชีที่เปิดกะไว้ให้แล้ว: reception.resort, cashier.karaoke, cashier.tours (ที่เหลือเปิดกะเอง ดู T03) (4) <b>บัญชีของ Palm Beach Co (2 บัญชี) ถูกสร้างด้วยรหัสผ่านสุ่ม</b> ต้องตั้งรหัสผ่านใหม่ที่ Supabase Auth ก่อนจึงจะล็อกอินได้</div>
<p>ผู้ดูแลแพลตฟอร์ม (สวิตช์ฟีเจอร์ สถิติ ตั้งค่า AI/LINE/แบรนด์) เป็นบัญชีของเจ้าของระบบที่ได้รับสิทธิ์แยกต่างหาก ไม่มีบัญชีเดโมใดได้สิทธิ์นี้ (ใช้ทดสอบ T32)</p>

<h1 class="pg">2 · รายชื่อผู้ใช้ทั้งหมด</h1>
<table>${head}<tbody><tr class="co"><td colspan="6">${esc(COMPANY1)} — บริษัทที่ 1 (22 บัญชี)</td></tr>${acctRows(ACCOUNTS)}<tr class="co"><td colspan="6">${esc(COMPANY2)} — บริษัทที่ 2 ในเครือข่ายเกาะ (2 บัญชี)</td></tr>${acctRows(BEACH)}</tbody></table>

<h1 class="pg">3 · บทบาทในระบบ: ทำอะไรได้ ทำอะไรไม่ได้</h1>
<table><thead><tr><th>บทบาท</th><th>ทำได้</th><th>ทำไม่ได้</th></tr></thead><tbody>${ROLES.map((r) => `<tr><td class="role">${esc(r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td></tr>`).join('')}</tbody></table>
<p>ระบบตรวจสิทธิ์ที่ฐานข้อมูล ถ้าปุ่มไม่ขึ้นหรือกดแล้วถูกปฏิเสธ ให้ดูว่าบัญชีนั้นเป็นบทบาทอะไรที่แถบบนสุดหรือหน้าบัญชี → "บทบาทของฉัน" และเมนูสีเทาแปลว่าโมดูลปิดอยู่ในร้านนั้น (เจ้าของเปิดที่เมนู "โมดูล") รายการสิทธิ์ครบทุกข้อและขั้นตอนทดสอบอยู่ใน docs/E2E-TEST-GUIDE.pdf</p>

<h1 class="pg">4 · จะทดสอบเรื่องไหน ใช้บัญชีอะไร</h1>
<table><thead><tr><th>flow</th><th>เรื่อง</th><th>บัญชีที่ใช้ (ตัดท้าย .demo${DOMAIN})</th></tr></thead><tbody>${FLOWS.map((f) => `<tr><td class="fl">${esc(f[0])}</td><td>${esc(f[1])}</td><td>${esc(f[2])}</td></tr>`).join('')}</tbody></table>
<p>ลิงก์/QR ของแขก (โต๊ะ จองซาลอน/สปา ทัวร์ ห้องคาราโอเกะ บัตรนักท่องเที่ยว ตลาดเกาะ) ไม่ต้องล็อกอิน ดูลิงก์ของแต่ละร้านที่หน้าของร้านนั้น (เช่น ผังโต๊ะ → QR สั่งอาหาร, ช่างและห้อง → จองออนไลน์, ด้านล่างของหน้าทัวร์/จองห้อง) หรือตลาดเกาะที่ /island/koh-phangan</p>
</body></html>`;

const out = join(root, 'docs');
mkdirSync(out, { recursive: true });
const { chromium } = require(
  process.env.PW_PATH || join(root, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(() => globalThis.document.fonts.ready);
await page.pdf({
  path: join(out, 'TEST-ACCOUNTS.pdf'),
  format: 'A4',
  landscape: true,
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<span></span>',
  footerTemplate:
    '<div style="font-size:8px;width:100%;text-align:center;color:#667">รายชื่อผู้ใช้ทดสอบ Bestie POS · หน้า <span class="pageNumber"></span>/<span class="totalPages"></span></div>',
  margin: { top: '12mm', bottom: '14mm', left: '11mm', right: '11mm' },
});
await browser.close();
console.log('done', ACCOUNTS.length + BEACH.length, 'accounts');
