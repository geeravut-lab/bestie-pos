// Builds docs/QUICK-GUIDES.pdf (one A5 page per shop type, Thai, for printing at the shop) and docs/quick-guides/*.jpg
// (the same pages as pictures to send through LINE). Phone screenshots come from tools/customer-guide/shots.
// Run: node tools/quick-guides/build.mjs   (needs Playwright's Chromium and pdftoppm for the pictures)
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
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
  const p = join(root, 'tools/customer-guide/shots', `${n}.jpg`);
  if (!existsSync(p)) throw new Error(`missing ${n}`);
  return `data:image/jpeg;base64,${b64(p)}`;
};

const CREDIT =
  'Bestie Credit = เงินเติมล่วงหน้า 1 บาท = 1 Credit ใช้ได้ทุกร้านของ<b>บริษัทเดียวกัน</b>เท่านั้น ถอนเป็นเงินสดไม่ได้ · แต้ม (Points) ได้จากยอดจ่าย ใช้เป็นส่วนลด ซื้อไม่ได้';
const PAGES = [
  {
    key: 'restaurant',
    icon: '🍜',
    title: 'ร้านอาหาร',
    sub: 'สั่งอาหารเองจากมือถือที่โต๊ะ',
    shots: [
      ['r01-table-top', 'สแกน QR ที่โต๊ะ'],
      ['r04-basket', 'เลือกเมนูใส่ตะกร้า'],
      ['r07-bill', 'ดูสถานะและบิล'],
    ],
    steps: [
      'สแกน <b>QR ที่โต๊ะ</b> ด้วยกล้องมือถือ (ไม่ต้องโหลดแอป)',
      'เลือกภาษา และกดตัวกรองถ้าแพ้อาหาร (ไม่กินหมู อาหารทะเล ฯลฯ) อาหารที่ร้านยังไม่ได้ตรวจจะแยกไว้ให้ "ถามพนักงาน"',
      'แตะเมนู เลือกตัวเลือก ใส่โน้ต แล้วกด <b>สั่ง</b>',
      'ดูสถานะอาหารที่หน้าเดิม กด "เรียกพนักงาน" หรือ "ขอบิล" ได้ตลอด',
      'จ่ายที่เคาน์เตอร์ (เงินสด PromptPay บัตร Credit) หรือกดจ่าย <b>PromptPay ที่โต๊ะ</b> แล้วรับใบเสร็จออนไลน์',
    ],
  },
  {
    key: 'cafe',
    icon: '☕',
    title: 'คาเฟ่',
    sub: 'สั่งที่ตู้ หรือสั่งออนไลน์ แล้วรับตามเลขคิว',
    shots: [
      ['o01-kiosk', 'ตู้สั่งเองหรือสแกน QR'],
      ['o03-kiosk-basket', 'เลือกเครื่องดื่ม'],
      ['o04-kiosk-number', 'ได้เลขคิว'],
    ],
    steps: [
      'สแกน QR ของร้านหรือแตะที่<b>ตู้สั่งเอง</b>',
      'เลือกเครื่องดื่ม ความหวาน นม และท็อปปิ้ง ใส่ตะกร้า',
      'กดสั่ง จะได้<b>เลขคิว</b> ใหญ่บนจอ (เช่น KS001)',
      '<b>จ่ายที่เคาน์เตอร์</b> แล้วรอดูเลขของคุณบนจอเรียกคิว',
      'สั่งออนไลน์จากนอกร้าน: ใส่ชื่อและเบอร์ ไปรับและจ่ายเมื่อรับสินค้า',
    ],
  },
  {
    key: 'salon',
    icon: '✂️',
    title: 'ซาลอน / ร้านทำผม',
    sub: 'จองคิวออนไลน์ เลือกช่างและเวลาเอง',
    shots: [
      ['s01-services', 'เลือกบริการและช่าง'],
      ['s02-times', 'เลือกวันและเวลาว่าง'],
      ['s05-done-full', 'จองสำเร็จ เก็บรหัส'],
    ],
    steps: [
      'สแกน <b>QR จองคิว</b> ของร้าน',
      'เลือกบริการ ช่าง (หรือ "ใครก็ได้") วัน แล้วเลือกเวลาที่ว่าง',
      'ใส่ชื่อและเบอร์โทร แล้วกดจอง',
      '<b>เก็บรหัสยกเลิก</b> (แสดงครั้งเดียว) ยกเลิกได้ก่อนเวลานัด',
      'รับข้อความเตือนทาง LINE (เพิ่มเพื่อนร้านแล้วส่งรหัสจอง) หรืออีเมล · ร้านอาจขอมัดจำ',
      'ถ้าเลือก ตอบ 4 คำถามเรื่องผมเพื่อดูสไตล์ที่เหมาะ และส่งรูปผมได้เมื่อติ๊กยินยอม (ลบอัตโนมัติ)',
    ],
  },
  {
    key: 'spa',
    icon: '💆',
    title: 'สปา / นวด',
    sub: 'จองคอร์ส บอกสุขภาพเบื้องต้น ให้นักบำบัดเตรียมตัว',
    shots: [
      ['s01-services', 'เลือกคอร์สนวด/สปา'],
      ['s03-filled', 'ใส่ชื่อและเบอร์'],
      ['s05-done-full', 'จองสำเร็จ เก็บรหัส'],
    ],
    steps: [
      'สแกน <b>QR จองคิว</b> ของร้าน เลือกคอร์ส (60/90/120 นาที) นักบำบัด วันและเวลา',
      'ไม่แน่ใจจองอะไร กด <b>"ไม่แน่ใจว่าจองอะไรดี"</b> ตอบเป้าหมาย แรงกด และข้อมูลสุขภาพ (ไม่ใช่คำแนะนำทางการแพทย์)',
      'กรอก<b>ฟอร์มสุขภาพ</b>บนมือถือได้ (ติ๊กยินยอมและพิมพ์ชื่อเป็นลายเซ็น) ร้านเก็บ 24 เดือนแล้วลบเอง',
      'เก็บ<b>รหัสยกเลิก</b> และรับข้อความเตือนก่อนนัด',
      'จ่ายที่เคาน์เตอร์ ใช้แพ็กเกจ/Credit ได้ (เฉพาะร้านของบริษัทเดียวกัน)',
    ],
  },
  {
    key: 'retail',
    icon: '🛍️',
    title: 'ร้านค้า / มินิมาร์ท',
    sub: 'สะสมแต้ม ใช้ Credit และรับใบเสร็จ',
    shots: [
      ['j03-pass', 'บัตรสมาชิกและแต้ม'],
      ['d03-credit-topped', 'เติม Credit'],
      ['y07-receipt', 'ใบเสร็จ'],
    ],
    steps: [
      'บอกเบอร์โทรหรือแสดง<b>QR บัตรสมาชิก</b>ให้แคชเชียร์ผูกกับบิล',
      'จ่ายได้ทั้งเงินสด PromptPay บัตร Credit หรือแบ่งจ่ายหลายแบบ',
      'ใช้<b>แต้ม</b>เป็นส่วนลดท้ายบิล (ขอใช้กับแคชเชียร์)',
      'อยากได้ใบกำกับภาษีเต็มรูป แจ้งชื่อ เลขผู้เสียภาษี และที่อยู่ก่อนออกบิล',
      'คืนสินค้า: เอาใบเสร็จมาที่ร้าน คืนเป็นเงินสด เข้า Credit หรือโอนคืนตามที่จ่ายมา',
    ],
  },
  {
    key: 'tours',
    icon: '🛶',
    title: 'ทัวร์ / กิจกรรม',
    sub: 'จองที่นั่งออนไลน์ มัดจำ และรับการเตือนก่อนเดินทาง',
    shots: [
      ['t01-tours', 'เลือกทัวร์และรอบ'],
      ['t02-filled', 'ใส่จำนวนที่นั่งและข้อมูล'],
      ['t03-done', 'จองสำเร็จ เก็บรหัส'],
    ],
    steps: [
      'สแกน <b>QR/ลิงก์จองทัวร์</b> ของร้าน',
      'เลือกทัวร์ รอบ และจำนวนที่นั่ง',
      'ใส่ชื่อและเบอร์โทร แล้วกดจอง จะได้<b>รหัสยกเลิก</b>',
      '<b>ชำระมัดจำ</b>ตามที่หน้าจอบอก (เงินสด/PromptPay/บัตร ผ่านร้าน) ถ้าไม่จ่ายตามเวลา ที่นั่งถูกปล่อย',
      'รับข้อความเตือนก่อนออกเดินทาง 1 วัน (LINE หรืออีเมล) · วันเดินทางแจ้งชื่อกับไกด์เพื่อเช็กอิน',
    ],
  },
  {
    key: 'karaoke',
    icon: '🎤',
    title: 'คาราโอเกะ',
    sub: 'จองห้อง ขอเพลงจากมือถือ จ่ายตามเวลาที่ใช้',
    shots: [
      ['k01-rooms', 'จองห้องล่วงหน้า'],
      ['k04-done', 'จองสำเร็จ เก็บรหัส'],
      ['m01-room', 'ขอเพลงที่ห้อง'],
    ],
    steps: [
      'จองห้องผ่าน <b>QR/ลิงก์จอง</b>: เลือกห้อง ความยาว วัน เวลา ใส่ชื่อและเบอร์ แล้วโอนมัดจำตามหมายเหตุของร้าน (ร้านรับแล้วจึงยืนยัน ไม่จ่ายตามเวลา ห้องจะถูกปล่อย)',
      'ที่ห้อง สแกน <b>QR ในห้อง</b> เพื่อดูเวลาที่เหลือและขอเพลง',
      'ค้นหาเพลงด้วยการพิมพ์ <b>หรือพูด</b> หรือวางลิงก์ YouTube (รอได้ 3 เพลง ซ้ำเพลงเดิมใน 10 นาทีไม่ได้)',
      'ร้านจับเวลาห้องในระบบ ต่อเวลา/พักได้ที่พนักงาน',
      'จ่ายที่เคาน์เตอร์ตามเวลาจริง (มัดจำหักออกให้) พร้อมอาหารเครื่องดื่มในบิลเดียว',
    ],
  },
  {
    key: 'resort',
    icon: '🏝️',
    title: 'รีสอร์ต',
    sub: 'ลงบิลเข้าห้อง หน้าข้อมูลสำหรับแขก และเรียกพนักงาน',
    shots: [
      ['i01-info', 'ข้อมูลรีสอร์ต ไวไฟ เวลาเช็กเอาต์'],
      ['r06-call', 'เรียกพนักงาน'],
      ['j04-island', 'ร้านในเกาะ'],
    ],
    steps: [
      'สแกน <b>QR ในห้อง/ล็อบบี้</b> เพื่อดูข้อมูล: ไวไฟ เวลาเปิด เช็กเอาต์ เคล็ดลับเกาะ',
      'พิมพ์คำถามได้ (ถ้าร้านเปิด) ระบบหาการ์ดข้อมูลของรีสอร์ตให้ ถ้าไม่เจอ กด <b>"เรียกพนักงาน"</b>',
      'กินอาหารหรือใช้บริการที่ร้านในรีสอร์ต แจ้ง<b>ลงบิลเข้าห้อง</b>กับพนักงาน (ทั้งบิลหรือบางส่วน)',
      'ค่าห้องรายคืนและรายการทั้งหมดรวมที่ใบสรุปตอนเช็กเอาต์ ชำระครั้งเดียว',
      'ให้คะแนนความพึงพอใจจากหน้าเดียวกัน (ถึงผู้จัดการทันทีถ้าคะแนนต่ำ)',
    ],
  },
];

const css = `
@font-face{font-family:'NST';src:url(data:font/woff2;base64,${b64(join(fontDir, 'noto-sans-thai-thai-wght-normal.woff2'))}) format('woff2');font-weight:100 900;unicode-range:U+0E01-0E5B,U+200C-200D,U+25CC}
@font-face{font-family:'NST';src:url(data:font/woff2;base64,${b64(join(fontDir, 'noto-sans-thai-latin-wght-normal.woff2'))}) format('woff2');font-weight:100 900;unicode-range:U+0000-00FF,U+2000-206F,U+2190-21FF,U+25A0-25FF}
@page{size:A5;margin:0}
:root{--p:#00796f;--ink:#0f2d4a;--bg:#f3fbfb;--acc:#ff7a59;--sun:#ffcb3d}
*{box-sizing:border-box}html,body{margin:0}body{font-family:'NST','Noto Sans Thai',sans-serif;color:var(--ink);font-size:9.6pt;line-height:1.5}
.page{width:148mm;height:210mm;padding:0 9mm 7mm;page-break-after:always;overflow:hidden;position:relative;background:#fff}
.head{margin:0 -9mm;padding:8mm 9mm 5mm;background:linear-gradient(135deg,#00796f,#13a394);color:#fff;border-bottom:3mm solid var(--sun)}
.head .t{font-size:21pt;font-weight:800;line-height:1.15}.head .s{font-size:10.5pt;opacity:.95;margin-top:1mm}.head .b{position:absolute;right:9mm;top:7mm;font-size:9pt;background:#fff;color:var(--p);border-radius:10pt;padding:1pt 8pt;font-weight:700}
.shots{display:flex;gap:3.5mm;margin:5mm 0 3mm}.shots figure{margin:0;flex:1;min-width:0}
.frame{height:80mm;border:1px solid #bcd3d1;border-radius:3mm;overflow:hidden;box-shadow:0 1px 3px rgba(15,45,74,.2)}.frame img{width:100%;display:block}
figcaption{font-size:7.6pt;text-align:center;color:#33495e;margin-top:1mm;line-height:1.25}
ol{margin:2mm 0 0;padding:0;list-style:none;counter-reset:s}ol li{counter-increment:s;position:relative;padding-left:8mm;margin:1.6mm 0;font-size:10pt;line-height:1.45}
ol li::before{content:counter(s);position:absolute;left:0;top:0;width:5.6mm;height:5.6mm;border-radius:50%;background:var(--acc);color:#fff;font-weight:800;font-size:8pt;text-align:center;line-height:5.6mm}
.credit{position:absolute;left:9mm;right:9mm;bottom:19mm;background:var(--bg);border:1px solid #cfe9e6;border-left:3pt solid var(--p);border-radius:2mm;padding:2mm 3mm;font-size:8pt;line-height:1.4}
.foot{position:absolute;left:9mm;right:9mm;bottom:6mm;display:flex;justify-content:space-between;font-size:7.5pt;color:#566}
.qr{position:absolute;right:9mm;bottom:19mm;display:none}
`;
const html = `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>คู่มือสั้นสำหรับลูกค้า Bestie POS</title><style>${css}</style></head><body>${PAGES.map(
  (
    pg,
  ) => `<div class="page"><div class="head"><div class="t">${pg.icon} ${pg.title}</div><div class="s">${pg.sub}</div><div class="b">ไม่ต้องโหลดแอป</div></div>
<div class="shots">${pg.shots.map(([n, c]) => `<figure><div class="frame"><img src="${img(n)}"></div><figcaption>${c}</figcaption></figure>`).join('')}</div>
<ol>${pg.steps.map((s) => `<li>${s}</li>`).join('')}</ol>
<div class="credit">${CREDIT}</div>
<div class="foot"><span>ร้าน: ____________________________</span><span>Bestie POS · คู่มือลูกค้าฉบับสั้น</span></div></div>`,
).join('')}</body></html>`;

const out = join(root, 'docs');
mkdirSync(join(out, 'quick-guides'), { recursive: true });
const { chromium } = require(
  process.env.PW_PATH || join(root, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(() => globalThis.document.fonts.ready);
await page.pdf({
  path: join(out, 'QUICK-GUIDES.pdf'),
  width: '148mm',
  height: '210mm',
  printBackground: true,
});
await browser.close();
// pictures for LINE (one per shop type)
const tmp = join(out, 'quick-guides', '_p');
execFileSync('pdftoppm', [
  '-r',
  '150',
  '-jpeg',
  '-jpegopt',
  'quality=85',
  join(out, 'QUICK-GUIDES.pdf'),
  tmp,
]);
const { readdirSync, renameSync } = await import('node:fs');
const files = readdirSync(join(out, 'quick-guides'))
  .filter((f) => f.startsWith('_p'))
  .sort();
files.forEach((f, i) =>
  renameSync(
    join(out, 'quick-guides', f),
    join(out, 'quick-guides', `${i + 1}-${PAGES[i].key}.jpg`),
  ),
);
console.log('done', PAGES.length, 'pages');
