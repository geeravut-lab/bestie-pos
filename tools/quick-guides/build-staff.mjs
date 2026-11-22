// Builds docs/STAFF-QUICK-GUIDES.pdf (one A5 page per role: cashier, waiter, kitchen) and docs/staff-quick-guides/*.jpg.
// Screenshots come from tools/staff-guide/shots. Run: node tools/quick-guides/build-staff.mjs
import { readFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
const img = (n) => {
  const p = join(root, 'tools/staff-guide/shots', `${n}.jpg`);
  if (!existsSync(p)) throw new Error(`missing ${n}`);
  return `data:image/jpeg;base64,${b64(p)}`;
};

const PAGES = [
  {
    key: 'cashier',
    icon: '💵',
    title: 'แคชเชียร์',
    sub: 'แท็บเล็ตที่เคาน์เตอร์ · เปิดกะ ขาย รับชำระ ปิดกะ',
    layout: 'grid',
    shots: [
      ['t02-pin', 'แตะชื่อ ใส่ PIN'],
      ['t08-order', 'บิล: สมาชิก ส่งครัว'],
      ['t10-pay-cash', 'รับชำระเงินสด'],
      ['t13-shift', 'เปิด/ปิดกะ'],
    ],
    steps: [
      '<b>เข้าใช้งาน:</b> แตะชื่อตัวเอง ใส่ PIN → ไปที่ "กะ" ใส่เงินในลิ้นชักตอนเปิด แล้วกด "เปิดกะ"',
      '<b>เปิดบิล:</b> โต๊ะ → แตะโต๊ะ หรือ ขาย → "ออเดอร์ใหม่" (คาเฟ่: เลขบิลคือเลขคิว) แตะเมนู เลือกตัวเลือกให้ครบ ใส่โน้ต',
      'ลูกค้าเป็นสมาชิก: ค้นหาด้วยเบอร์/รหัส แล้วใส่ที่บิล (ได้แต้ม ใช้ Credit ได้)',
      'กด <b>ส่งครัว/บาร์</b> (รายการที่ส่งแล้วแก้ไม่ได้) แล้วกด <b>รับชำระ</b> เลือก เงินสด / PromptPay / บัตร / Credit / แบ่งจ่าย',
      'PromptPay/บัตร: <b>รอระบบยืนยันเอง</b> ห้ามปิดบิลจากสลิป · เงินสด: ใส่เงินที่รับ ดูเงินทอน',
      'ก่อนเดินออก กด <b>ล็อกเครื่อง</b> · ปิดกะ: นับเงินจริงใส่ในหน้า "กะ" ส่วนต่างไปถึงผู้จัดการ',
    ],
    ask: '<b>ขอผู้จัดการ (ใส่ PIN):</b> ยกเลิกรายการที่ส่งแล้ว · ส่วนลด · คืนเงิน/คืนสินค้า · ปรับยอด Credit · <b>ไม่เคยมีปุ่มถอน Credit เป็นเงินสด</b> และ Credit ใช้ได้เฉพาะร้านของบริษัทเดียวกัน',
  },
  {
    key: 'waiter',
    icon: '🍽️',
    title: 'พนักงานเสิร์ฟ / รับออเดอร์',
    sub: 'มือถือหรือแท็บเล็ตเล็ก · เปิดโต๊ะ สั่ง ส่งครัว เสิร์ฟ',
    layout: 'phones',
    shots: [
      ['w01-home', 'หน้าแรก'],
      ['w02-tables', 'ผังโต๊ะ'],
      ['w03-table-order', 'สั่งอาหาร'],
      ['w06-ready', 'พร้อมเสิร์ฟ'],
    ],
    steps: [
      '<b>เข้าใช้งาน:</b> แตะชื่อ ใส่ PIN เมนูอยู่แถบล่าง (หน้าแรก โต๊ะ สั่ง พร้อมเสิร์ฟ เพิ่มเติม)',
      '<b>โต๊ะ:</b> แตะโต๊ะ (เห็นว่างหรือมีบิล) แถบสีเหลืองคือ <b>แขกเรียก/ขอบิล</b> ไปถึงแล้วกด "รับทราบ"',
      '<b>สั่ง:</b> แตะเมนู เลือกตัวเลือก ใส่โน้ตเรื่องแพ้อาหาร/ไม่เผ็ด แล้วกด <b>ส่งครัว/บาร์</b>',
      'ออเดอร์ที่แขกสั่งเองผ่าน QR ขึ้นเป็น "รายการจากแขก" ให้ตรวจแล้วกดส่งครัว',
      '<b>พร้อมเสิร์ฟ:</b> เมื่อครัวกดพร้อม รายการขึ้นที่หน้านี้ เสิร์ฟแล้วกด "เสิร์ฟแล้ว"',
      'แขกขอเก็บเงิน: แจ้งแคชเชียร์ หรือให้แขกจ่าย PromptPay จาก QR ที่โต๊ะ (บิลถูกล็อกระหว่างจ่าย)',
    ],
    ask: '<b>เสิร์ฟไม่มีสิทธิ์:</b> รับชำระเงิน · ยกเลิกรายการที่ส่งแล้ว · ลดราคา · ดูรายงาน ให้ขอผู้จัดการ/แคชเชียร์ · เน็ตหลุดสั่งและส่งครัวได้ รอซิงก์ทีหลัง (ดูจุดสถานะบนแถบบน)',
  },
  {
    key: 'kitchen',
    icon: '👨‍🍳',
    title: 'ครัวและบาร์',
    sub: 'แท็บเล็ตติดผนัง · จอ KDS และตั๋วครัว',
    layout: 'wide',
    shots: [
      ['k01-kds', 'จอ KDS ของสถานี: ตั๋วเรียงเก่าก่อน'],
      ['k02-kds', 'สีตามเวลารอ: 8 นาทีเหลือง 15 นาทีแดง'],
    ],
    steps: [
      '<b>เข้าใช้งาน:</b> บัญชีครัว/บาร์ประจำเครื่อง เห็นเฉพาะตั๋วของสถานีตัวเอง (ครัวหรือบาร์) จอไม่เลือกสถานีเห็นทุกสถานี',
      'ตั๋วใหม่ขึ้นทุกครั้งที่ร้านกด "ส่งครัว/บาร์" (มีเสียงเตือนถ้าเปิด) <b>ตั๋วใหม่ต้องมีเน็ต</b> ถ้าจอแจ้งออฟไลน์ ให้ต่อเน็ตก่อน',
      'ทำเสร็จกด <b>"พร้อม"</b> → ขึ้นที่ "พร้อมเสิร์ฟ" ของพนักงาน กดผิดกด "ยกเลิก" ย้อนได้ 1 ขั้น',
      'สีบอกเวลารอ: เหลือง 8 นาที แดง 15 นาที ทำตั๋วสีแดงก่อน',
      '<b>ตั๋วพิมพ์:</b> ถ้ามีเครื่องพิมพ์ครัว ตั๋วภาษาไทยไม่มีราคาออกเอง · ออเดอร์ QR ที่ส่งอัตโนมัติพิมพ์ที่ "สถานีพิมพ์" (หน้าต้องเปิดค้างและจอไม่ดับ)',
    ],
    ask: '<b>จอครัวไม่เห็นตั๋วของเมนูไหน?</b> เมนูนั้นยังไม่ได้ตั้งสถานี ให้บอกผู้จัดการ · จอครัวไม่รับออเดอร์ ไม่แก้ราคาหรือรายการ · เครื่องพิมพ์เสียไม่ขวางการส่งออเดอร์ จอ KDS ยังเห็นตั๋วเสมอ',
  },
  {
    key: 'manager',
    icon: '🧑‍💼',
    title: 'ผู้จัดการ',
    sub: 'แท็บเล็ตหรือคอมพิวเตอร์ · อนุมัติ รายงาน ทีมงาน คืนเงิน',
    layout: 'grid',
    shots: [
      ['g01-home', 'หน้าแรกของผู้จัดการ'],
      ['g02-reports', 'รายงานยอดขาย'],
      ['g04-receipt-open', 'ใบเสร็จ: พิมพ์ ใบกำกับภาษี คืนสินค้า'],
      ['g05-staff', 'ทีมงาน PIN บทบาท'],
    ],
    steps: [
      '<b>อนุมัติหน้าเครื่องแคชเชียร์:</b> พิมพ์ PIN ของตัวเองเมื่อแคชเชียร์ขอ ยกเลิกรายการที่ส่งแล้ว (ต้องมีเหตุผล) หรือส่วนลด % / บาท ระบบบันทึกชื่อผู้อนุมัติ · PIN ผิด 5 ครั้งล็อก 15 นาที',
      '<b>คืนเงิน/คืนสินค้า:</b> ใบเสร็จ → คืนสินค้า เลือกรายการ เหตุผล และเส้นทาง (เงินสดจากลิ้นชัก / เข้า Credit ของสมาชิก / PromptPay-บัตรคืนมือใน Stripe แล้วกด "คืนแล้ว") ยอดคำนวณโดยระบบ',
      '<b>เงินที่รอตรวจ:</b> แจ้งเตือน "ต้องตรวจ" = PromptPay/บัตรที่ยอดไม่ตรง เปิดที่ กระทบยอด ห้ามปิดบิลเองจากสลิป · กะที่ส่วนต่างเกินเกณฑ์ก็แจ้งมาที่คุณ',
      '<b>ทีมงาน:</b> พนักงาน → เชิญด้วยรหัสครั้งเดียว ตั้ง PIN เปลี่ยนบทบาท ปิดการใช้งาน (ตั้ง PIN ให้เจ้าของไม่ได้) · สร้างบทบาทเองได้แต่มอบสิทธิ์ที่ตัวเองไม่มีไม่ได้',
      '<b>รายงาน:</b> ยอดรายวัน/รายการ/ชั่วโมง/ช่องจ่าย/พนักงาน เลือกร้านเดียวหรือทุกร้าน ส่งออก CSV (มีบันทึก) · สต็อก ใบสั่งซื้อ ตอกบัตร ตารางกะ อยู่ที่เมนูของแต่ละโมดูล',
    ],
    ask: '<b>ผู้จัดการทำไม่ได้:</b> เปิดหน้า Crypto (เจ้าของเท่านั้น) · หน้าของผู้ดูแลแพลตฟอร์ม · ตั้งค่าภาษี/บิลและแต้ม/นโยบายบัญชี/โมดูล (เจ้าของ) · <b>Credit ถอนเป็นเงินสดไม่ได้เลย</b> ปรับยอดได้เฉพาะผู้มีสิทธิ์ พร้อมเหตุผล',
  },
  {
    key: 'frontdesk',
    icon: '💇',
    title: 'ต้อนรับ ซาลอน / สปา',
    sub: 'แท็บเล็ตที่เคาน์เตอร์ · นัดหมาย มัดจำ เปิดบิล แฟ้มลูกค้า',
    layout: 'grid',
    shots: [
      ['f01-salon-calendar', 'ปฏิทินซาลอน คอลัมน์ต่อช่าง'],
      ['f03-salon-booking-open', 'เปิดนัด: มัดจำ ทิป เปิดบิล'],
      ['f05-spa-calendar', 'ปฏิทินสปา ห้อง/เตียง'],
      ['f04-client-record', 'แฟ้มลูกค้า ฟอร์มสุขภาพ'],
    ],
    steps: [
      '<b>จอง:</b> ปฏิทิน → แตะช่องของช่าง/ห้อง เลือกบริการ (ความยาวและราคาเติมให้) ใส่ชื่อลูกค้า (เลือกเป็นสมาชิกได้) ถ้าเวลาชนกับนัด/วันหยุด/พัก ระบบปฏิเสธ (ติดกันได้)',
      '<b>มัดจำ:</b> กด "รับมัดจำ" (แนะนำ 30%) เงินสดเข้าลิ้นชัก / PromptPay-โอน / บัตร ได้ใบรับมัดจำ DP-… พิมพ์ 80 มม.',
      '<b>วันนัด:</b> สถานะเดินหน้าอย่างเดียว ยืนยัน → มาถึง → กำลังบริการ → เสร็จ · มาถึงแล้วกด <b>เปิดบิล</b> (AP001…) มัดจำหักเป็นส่วนที่จ่ายแล้ว รับชำระส่วนที่เหลือ',
      '<b>เตือนลูกค้า:</b> ใส่อีเมล หรือกด "รหัสครั้งเดียว" ให้ลูกค้าส่งใน LINE ของร้าน ระบบเตือนก่อนนัดแล้วลบข้อมูลติดต่อ · จองเป็นกลุ่ม 2–8 คน ที่ "จองกลุ่ม"',
      '<b>สปา:</b> กรอกฟอร์มสุขภาพ<b>พร้อมลูกค้า</b> (ติ๊กยินยอม พิมพ์ชื่อเต็มเป็นลายเซ็น) แก้ไม่ได้ ถ้าต้องแก้ให้ทำฉบับใหม่ · รูปก่อน/หลัง ต้องติ๊กยินยอมของลูกค้าก่อนเสมอ',
    ],
    ask: '<b>ขอผู้จัดการ:</b> ยึดมัดจำของนัดที่ยกเลิก/ไม่มา หรือคืนมัดจำ · ลบแฟ้ม/ฟอร์มสุขภาพตามคำขอลูกค้า · ตั้งวันหยุดช่าง · อัตราคอมมิชชัน · รูปผมที่ลูกค้าส่งถูกลบเองหลังนัดจบ ห้ามเก็บสำเนาไว้ที่อื่น',
  },
];

const css = `
@font-face{font-family:'NST';src:url(data:font/woff2;base64,${b64(join(fontDir, 'noto-sans-thai-thai-wght-normal.woff2'))}) format('woff2');font-weight:100 900;unicode-range:U+0E01-0E5B,U+200C-200D,U+25CC}
@font-face{font-family:'NST';src:url(data:font/woff2;base64,${b64(join(fontDir, 'noto-sans-thai-latin-wght-normal.woff2'))}) format('woff2');font-weight:100 900;unicode-range:U+0000-00FF,U+2000-206F,U+2190-21FF,U+25A0-25FF}
@page{size:A5;margin:0}
:root{--p:#00796f;--ink:#0f2d4a;--bg:#f3fbfb;--acc:#ff7a59;--sun:#ffcb3d}
*{box-sizing:border-box}html,body{margin:0}body{font-family:'NST','Noto Sans Thai',sans-serif;color:var(--ink);font-size:9.6pt;line-height:1.5}
.page{width:148mm;height:210mm;padding:0 9mm 7mm;page-break-after:always;overflow:hidden;position:relative;background:#fff}
.head{margin:0 -9mm;padding:8mm 9mm 5mm;background:linear-gradient(135deg,#0f2d4a,#1d5b86);color:#fff;border-bottom:3mm solid var(--sun)}
.head .t{font-size:20pt;font-weight:800;line-height:1.15}.head .s{font-size:10pt;opacity:.95;margin-top:1mm}
.shots{display:flex;gap:3mm;margin:4.5mm 0 3mm}.shots figure{margin:0;flex:1;min-width:0}
.frame{border:1px solid #bcd3d1;border-radius:2.5mm;overflow:hidden;box-shadow:0 1px 3px rgba(15,45,74,.2)}.frame img{width:100%;display:block}
.grid{flex-wrap:wrap}.grid figure{flex:0 0 calc(50% - 1.5mm)}.grid .frame{height:33mm}.grid img{object-fit:cover;object-position:top}
.phones .frame{height:84mm}.phones img{object-fit:cover;object-position:top;height:100%}
.wide{flex-direction:row}.wide .frame{height:62mm}.wide img{object-fit:cover;object-position:top}
figcaption{font-size:7.4pt;text-align:center;color:#33495e;margin-top:1mm;line-height:1.25}
ol{margin:2mm 0 0;padding:0;list-style:none;counter-reset:s}ol li{counter-increment:s;position:relative;padding-left:8mm;margin:1.2mm 0;font-size:8.9pt;line-height:1.38}
ol li::before{content:counter(s);position:absolute;left:0;top:0;width:5.6mm;height:5.6mm;border-radius:50%;background:var(--acc);color:#fff;font-weight:800;font-size:8pt;text-align:center;line-height:5.6mm}
.ask{position:absolute;left:9mm;right:9mm;bottom:14mm;background:#fff6e0;border:1px solid #f1d28a;border-left:3pt solid #e8a400;border-radius:2mm;padding:2mm 3mm;font-size:8pt;line-height:1.4}
.foot{position:absolute;left:9mm;right:9mm;bottom:5mm;display:flex;justify-content:space-between;font-size:7.5pt;color:#566}
`;
const html = `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>คู่มือสั้นสำหรับพนักงาน Bestie POS</title><style>${css}</style></head><body>${PAGES.map(
  (
    pg,
  ) => `<div class="page"><div class="head"><div class="t">${pg.icon} ${pg.title}</div><div class="s">${pg.sub}</div></div>
<div class="shots ${pg.layout === 'grid' ? 'grid' : pg.layout}">${pg.shots.map(([n, c]) => `<figure><div class="frame"><img src="${img(n)}"></div><figcaption>${c}</figcaption></figure>`).join('')}</div>
<ol>${pg.steps.map((s) => `<li>${s}</li>`).join('')}</ol>
<div class="ask">${pg.ask}</div>
<div class="foot"><span>ร้าน: ____________________________</span><span>Bestie POS · คู่มือพนักงานฉบับสั้น · คู่มือเต็ม: STAFF-GUIDE.pdf</span></div></div>`,
).join('')}</body></html>`;

const out = join(root, 'docs');
mkdirSync(join(out, 'staff-quick-guides'), { recursive: true });
const { chromium } = require(
  process.env.PW_PATH || join(root, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(() => globalThis.document.fonts.ready);
await page.pdf({
  path: join(out, 'STAFF-QUICK-GUIDES.pdf'),
  width: '148mm',
  height: '210mm',
  printBackground: true,
});
await browser.close();
execFileSync('pdftoppm', [
  '-r',
  '150',
  '-jpeg',
  '-jpegopt',
  'quality=85',
  join(out, 'STAFF-QUICK-GUIDES.pdf'),
  join(out, 'staff-quick-guides', '_p'),
]);
const files = readdirSync(join(out, 'staff-quick-guides'))
  .filter((f) => f.startsWith('_p'))
  .sort();
files.forEach((f, i) =>
  renameSync(
    join(out, 'staff-quick-guides', f),
    join(out, 'staff-quick-guides', `${i + 1}-${PAGES[i].key}.jpg`),
  ),
);
console.log('done', PAGES.length, 'pages');
