// Builds docs/E2E-TEST-GUIDE.html and .pdf (Thai) from flows1/flows2/content.
// Run: node tools/e2e-guide/build.mjs   (needs Playwright's Chromium and the shots in $SHOTS_DIR, default /tmp/shots)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLOWS1 } from './flows1.mjs';
import { FLOWS2 } from './flows2.mjs';
import * as C from './content.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const require = createRequire(import.meta.url);
const fontDir = join(
  root,
  'node_modules/.pnpm/@fontsource-variable+noto-sans-thai@5.3.0/node_modules/@fontsource-variable/noto-sans-thai/files',
);
const b64 = (p) => readFileSync(p).toString('base64');
const shotsDir = process.env.SHOTS_DIR || '/tmp/shots';
const FLOWS = [...FLOWS1, ...FLOWS2];
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

// role -> lane colour
const LANE_COLORS = [
  '#00796f',
  '#ff7a59',
  '#7c5cff',
  '#d99a00',
  '#2f80ed',
  '#c2410c',
  '#0f766e',
  '#be185d',
  '#475569',
];
const laneOf = (list) => {
  const m = new Map();
  list.forEach((r) => {
    if (!m.has(r)) m.set(r, LANE_COLORS[m.size % LANE_COLORS.length]);
  });
  return m;
};

function swimlane(f) {
  const roles = [...new Set(f.steps.map((s) => s[0]))];
  const colors = laneOf(roles);
  const head = roles.map((r) => `<th style="background:${colors.get(r)}">${esc(r)}</th>`).join('');
  const body = f.steps
    .map((s, i) => {
      const cells = roles
        .map((r) =>
          r === s[0]
            ? `<td><span class="dot" style="background:${colors.get(r)}">${i + 1}</span><span class="lane-text">${esc(s[2].length > 70 ? s[2].slice(0, 68) + '…' : s[2])}</span></td>`
            : '<td class="empty"></td>',
        )
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  return `<table class="lane"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function flowHtml(f) {
  const steps = f.steps
    .map(
      (s, i) =>
        `<tr><td class="n">${i + 1}</td><td class="who">${esc(s[0])}</td><td class="where">${esc(s[1])}</td><td>${esc(s[2])}</td><td class="exp">${esc(s[3])}</td><td class="chk"><span class="box"></span> ผ่าน<br><span class="box"></span> ไม่ผ่าน</td></tr>`,
    )
    .join('');
  const pre = (f.pre || []).map((p) => `<li>${esc(p)}</li>`).join('');
  const notes = (f.notes || []).map((p) => `<li>${esc(p)}</li>`).join('');
  return `<section class="flow">
<h2><span class="fid">${f.id}</span> ${esc(f.title)}</h2>
<p class="goal"><b>เป้าหมาย:</b> ${esc(f.goal)}</p>
<p class="meta"><b>บทบาทที่เกี่ยวข้อง:</b> ${f.roles.map(esc).join(' · ')}</p>
${pre ? `<div class="pre"><b>เตรียมก่อนเริ่ม</b><ul>${pre}</ul></div>` : ''}
<h3>แผนภาพช่องบทบาท</h3>${swimlane(f)}
<h3>ขั้นตอนทดสอบ</h3>
<table class="steps"><thead><tr><th>#</th><th>ใคร</th><th>ที่ไหน</th><th>ทำอะไร</th><th>ผลลัพธ์ที่ต้องเห็น</th><th>ผล</th></tr></thead><tbody>${steps}</tbody></table>
${notes ? `<div class="notes"><b>หมายเหตุ</b><ul>${notes}</ul></div>` : ''}
<p class="rec">บันทึกผู้ทดสอบ: ________________ วันที่: ____________ ข้อบกพร่องที่พบ: ______________________________________________</p>
</section>`;
}

const groups = [...new Set(FLOWS.map((f) => f.group))];
const toc = groups
  .map(
    (g) =>
      `<div class="tocg"><b>${esc(g)}</b>${FLOWS.filter((f) => f.group === g)
        .map((f) => `<div class="tocr"><span>${f.id}</span><span>${esc(f.title)}</span></div>`)
        .join('')}</div>`,
  )
  .join('');

const rolesHtml = C.ROLES.map((r) => {
  const img =
    r.shot && existsSync(join(shotsDir, `${r.shot}.jpg`))
      ? `<img class="shot" src="data:image/jpeg;base64,${b64(join(shotsDir, `${r.shot}.jpg`))}">`
      : '';
  return `<section class="role"><div class="rtxt"><h3>${esc(r.name)}</h3><p class="app">ใช้งานผ่าน: ${esc(r.app)}</p><p>${esc(r.summary)}</p>
<div class="two"><div><b class="g">ทำได้</b><ul>${r.can.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div><div><b class="r">ทำไม่ได้</b><ul>${r.cannot.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div></div>
<p class="acc"><b>บัญชีทดสอบ:</b> ${esc(r.accounts)}</p></div>${img}</section>`;
}).join('');

const roleNames = Object.keys(C.PERM_MATRIX);
const permRows = C.PERMS.map(
  ([k, d]) =>
    `<tr><td><code>${k}</code></td><td>${esc(d)}</td>${roleNames
      .map((n) => {
        const v = C.PERM_MATRIX[n];
        return `<td class="c">${v === 'all' || v.includes(k) ? '●' : ''}</td>`;
      })
      .join('')}</tr>`,
).join('');
const permTable = `<table class="perm"><thead><tr><th>สิทธิ์</th><th>ใช้ทำอะไร</th>${roleNames.map((n) => `<th class="v">${esc(n)}</th>`).join('')}</tr></thead><tbody>${permRows}</tbody></table>`;

const accTable = `<table class="steps"><thead><tr><th>บัญชี (@bestiedemo.example)</th><th>บทบาท</th><th>ร้าน</th><th>ใช้ทดสอบ</th></tr></thead><tbody>${C.ACCOUNTS.map((a) => `<tr><td><code>${esc(a[0])}</code></td><td>${esc(a[1])}</td><td>${esc(a[2])}</td><td>${esc(a[3])}</td></tr>`).join('')}</tbody></table>`;
const dataTable = `<table class="steps"><thead><tr><th>ร้าน/กลุ่ม</th><th>ข้อมูลเดโมที่มีอยู่แล้ว</th></tr></thead><tbody>${C.DEMO_DATA.map((a) => `<tr><td class="who">${esc(a[0])}</td><td>${esc(a[1])}</td></tr>`).join('')}</tbody></table>`;
const noTable = `<table class="steps"><thead><tr><th>เรื่อง</th><th>เหตุผล/วิธีทดสอบ</th></tr></thead><tbody>${C.NOT_TESTABLE.map((a) => `<tr><td class="who">${esc(a[0])}</td><td>${esc(a[1])}</td></tr>`).join('')}</tbody></table>`;

const css = `
@font-face{font-family:'NST';src:url(data:font/woff2;base64,${b64(join(fontDir, 'noto-sans-thai-thai-wght-normal.woff2'))}) format('woff2');font-weight:100 900;unicode-range:U+0E01-0E5B,U+200C-200D,U+25CC}
@font-face{font-family:'NST';src:url(data:font/woff2;base64,${b64(join(fontDir, 'noto-sans-thai-latin-wght-normal.woff2'))}) format('woff2');font-weight:100 900;unicode-range:U+0000-00FF,U+2000-206F,U+2190-21FF,U+25A0-25FF}
@page{size:A4;margin:14mm 12mm 16mm}
:root{--p:#00796f;--ink:#0f2d4a;--bg:#f3fbfb;--acc:#ff7a59}
*{box-sizing:border-box}body{font-family:'NST','Noto Sans Thai',sans-serif;color:var(--ink);font-size:10pt;line-height:1.55;margin:0}
h1{font-size:30pt;margin:0 0 6pt;color:var(--p)}h2{font-size:15pt;margin:0 0 6pt}h3{font-size:11.5pt;margin:12pt 0 4pt;color:var(--p)}
.cover{height:255mm;display:flex;flex-direction:column;justify-content:center;background:linear-gradient(160deg,#e6f7f5,#fff 60%);padding:0 14mm;page-break-after:always;border-left:6mm solid var(--p)}
.cover .sub{font-size:14pt;margin-bottom:24pt}.cover .bx{background:#fff;border:1px solid #cfe9e6;border-radius:8pt;padding:10pt 12pt;font-size:10pt;margin-top:10pt}
.part{page-break-before:always}.part>h1{font-size:20pt;border-bottom:3pt solid var(--acc);padding-bottom:4pt;margin-bottom:10pt}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #cfdcdc;padding:3pt 5pt;vertical-align:top;font-size:8.6pt}
th{background:var(--p);color:#fff;text-align:left}code{font-family:monospace;font-size:8pt;background:#eef5f5;padding:0 2pt}
.flow{page-break-before:always}.fid{background:var(--p);color:#fff;border-radius:4pt;padding:1pt 6pt;margin-right:4pt}
.goal,.meta{margin:2pt 0}.pre,.notes{background:var(--bg);border:1px solid #cfe9e6;border-radius:5pt;padding:4pt 8pt;margin:6pt 0;font-size:9pt}.pre ul,.notes ul{margin:2pt 0 0;padding-left:14pt}
table.lane th{text-align:center;font-size:8.6pt}table.lane td{height:20pt;padding:2pt 4pt;font-size:8pt}table.lane td.empty{background:repeating-linear-gradient(45deg,#fafcfc,#fafcfc 4px,#fff 4px,#fff 8px)}
.dot{display:inline-block;min-width:13pt;height:13pt;border-radius:50%;color:#fff;font-size:7.5pt;text-align:center;line-height:13pt;margin-right:3pt;font-weight:700}
table.steps tr{page-break-inside:avoid}.n{width:16pt;text-align:center;font-weight:700}.who{width:52pt;font-weight:600}.where{width:62pt;color:#334}.exp{background:#f4fbf6}.chk{width:44pt;font-size:8pt;white-space:nowrap}
.box{display:inline-block;width:8pt;height:8pt;border:1px solid #556;margin-right:2pt;vertical-align:middle}
.rec{font-size:8.5pt;color:#556;margin-top:8pt;border-top:1px dashed #9ab}
.role{display:flex;gap:10pt;page-break-inside:avoid;margin-bottom:12pt;border:1px solid #cfe9e6;border-radius:6pt;padding:8pt}.rtxt{flex:1}.role h3{margin-top:0;font-size:12.5pt}.shot{width:46mm;height:auto;border:1px solid #ccd;border-radius:6pt;align-self:flex-start}
.app{color:#556;margin:0 0 3pt}.two{display:flex;gap:10pt}.two>div{flex:1}.two ul{margin:2pt 0;padding-left:12pt;font-size:9pt}.g{color:#0a7a3a}.r{color:#b3261e}.acc{font-size:8.6pt;margin:4pt 0 0;color:#334}
table.perm th.v{writing-mode:vertical-rl;text-align:left;height:56pt}table.perm td.c{text-align:center;color:var(--p);font-weight:700;width:20pt}
.tocg{margin-bottom:6pt}.tocr{display:flex;gap:8pt;font-size:9.5pt;padding-left:8pt}.tocr span:first-child{font-weight:700;color:var(--p);width:26pt}
ul.how{padding-left:14pt}.leg td:first-child{font-weight:700;width:90pt}
.footer-note{font-size:8.5pt;color:#667}
`;

const html = `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${C.TITLE}</title><style>${css}</style></head><body>
<div class="cover"><h1>${C.TITLE}</h1><div class="sub">${C.SUBTITLE}</div>
<div class="bx"><b>จำนวน flow ทดสอบ:</b> ${FLOWS.length} flow · <b>บทบาท:</b> ${C.ROLES.length} · <b>บัญชีทดสอบ:</b> ${C.ACCOUNTS.length}<br><b>ระบบ:</b> https://bestie-pos.vercel.app/ · <b>จัดทำ:</b> ${new Date().toISOString().slice(0, 10)}</div>
<div class="bx">ข้อมูลทั้งหมดใน [DEMO] Island Group, [DEMO] Palm Beach Co และบัญชี @bestiedemo.example เป็นข้อมูลทดสอบ จะถูกลบก่อนเปิดใช้งานจริง</div></div>

<div class="part" style="page-break-before:avoid"><h1>ส่วนที่ 1 · วิธีใช้เอกสารนี้</h1>
<h3>ทำไมเลือกรูปแบบ Flow + ขั้นตอนทดสอบ</h3><ul class="how">${C.WHY_FORMAT.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
<h3>วิธีอ่านและวิธีทดสอบ</h3><table class="steps"><tbody>${C.HOW_TO.map((h) => `<tr><td class="who">${esc(h[0])}</td><td>${esc(h[1])}</td></tr>`).join('')}</tbody></table>
<h3>สถานะของแต่ละหัวข้อ</h3><table class="steps leg"><tbody>${C.LEGEND.map((h) => `<tr><td>${esc(h[0])}</td><td>${esc(h[1])}</td></tr>`).join('')}</tbody></table>
<h3>สารบัญ flow</h3>${toc}</div>

<div class="part"><h1>ส่วนที่ 2 · บทบาททั้งหมด: ใครทำอะไรได้</h1>
<p>ระบบตัดสินจากบัญชีที่ล็อกอิน (และ PIN ของคนที่ยืนหน้าเครื่อง) ว่าเห็นเมนูอะไร สิ่งที่ซ่อนไว้ไม่ใช่แค่ซ่อนปุ่ม แต่ฐานข้อมูลปฏิเสธการกระทำนั้นจริง ถ้ารู้สึกว่า "ทำไมกดไม่ได้" ให้ดูว่าบัญชีนั้นเป็นบทบาทอะไรที่แถบบนสุด หรือที่หน้าบัญชี → "บทบาทของฉัน"</p>
<p><b>สองชั้นที่มักทำให้สับสน:</b> (1) <b>โมดูลปิด</b> = เมนูเป็นสีเทาทั้งร้าน เจ้าของเปิดที่เมนู "โมดูล" (2) <b>สิทธิ์ไม่พอ</b> = เมนูไม่ขึ้นหรือกดแล้วถูกปฏิเสธ ต้องใช้บัญชีบทบาทที่สูงกว่าหรือขอ PIN ผู้จัดการ (ผู้จัดการเดโมใช้ PIN 1234)</p>
${rolesHtml}
<h3>ตารางสิทธิ์ต่อบทบาท</h3>${permTable}
<p class="footer-note">เจ้าของมีทุกสิทธิ์เสมอ บทบาทที่ร้านสร้างเอง (นักบัญชี ผู้ดูแลสต็อก) เลือกสิทธิ์จากรายการนี้ที่เมนู พนักงาน → บทบาท และมอบสิทธิ์ที่ตัวเองไม่มีให้คนอื่นไม่ได้</p></div>

<div class="part"><h1>ส่วนที่ 3 · Flow ทดสอบ (${FLOWS.length} flow)</h1>
<p>ทำเรียง T01 → T03 ก่อน เพราะสร้างความคุ้นเคยกับการสลับบัญชี หลังจากนั้นเลือกทำตามร้าน/โมดูลที่ต้องการแสดงให้เจ้าของกลุ่มดู</p></div>
${FLOWS.map(flowHtml).join('\n')}

<div class="part"><h1>ภาคผนวก ก · บัญชีทดสอบ</h1>
<p>ทุกบัญชีใช้รหัสผ่านกลางที่เจ้าของระบบตั้งไว้ (ไม่พิมพ์ในเอกสาร) PIN ของพนักงานคือ <b>1234</b> บัญชีบนเครื่อง POS ใช้ได้ทั้งการล็อกอินและล็อกหน้าจอด้วย PIN ไม่มีบัญชีเดโมใดเป็นผู้ดูแลแพลตฟอร์ม</p>${accTable}</div>
<div class="part" style="page-break-before:avoid"><h1>ภาคผนวก ข · ข้อมูลเดโมที่มีอยู่แล้ว</h1>${dataTable}</div>
<div class="part"><h1>ภาคผนวก ค · สิ่งที่ทดสอบไม่ได้หรือต้องมีของจริง</h1><p>รายการนี้ไม่ใช่ข้อบกพร่อง แต่คือสิ่งที่ต้องมีคีย์ อุปกรณ์ หรือการตรวจจากผู้เชี่ยวชาญก่อน</p>${noTable}</div>
</body></html>`;

const out = join(root, 'docs');
mkdirSync(out, { recursive: true });
if (process.env.KEEP_HTML) writeFileSync(join(out, 'E2E-TEST-GUIDE.html'), html);
const { chromium } = require(
  process.env.PW_PATH ||
    '/home/user/bestie-pos/node_modules/.pnpm/playwright@1.63.0/node_modules/playwright',
);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(() => globalThis.document.fonts.ready);
await page.pdf({
  path: join(out, 'E2E-TEST-GUIDE.pdf'),
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<span></span>',
  footerTemplate:
    '<div style="font-size:8px;width:100%;text-align:center;color:#667">Bestie POS · คู่มือทดสอบ E2E · หน้า <span class="pageNumber"></span>/<span class="totalPages"></span></div>',
  margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' },
});
await browser.close();
console.log('done', FLOWS.length, 'flows');
