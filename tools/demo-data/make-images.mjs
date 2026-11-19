#!/usr/bin/env node
// Draws the demo menu pictures (a colour tile with a big emoji) into tools/demo-data/images/*.jpg and writes manifest.json.
// They are PLACEHOLDERS to show how pictures look in the till and on the guest page; the owner replaces them with real photos.
// Needs Playwright + Chromium (the build sandbox has both):  node tools/demo-data/make-images.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'images');
mkdirSync(out, { recursive: true });

// [shop, Thai name, emoji, colour 1, colour 2]
const ITEMS = [
  ['Island Kitchen', 'ปอเปี๊ยะทอด', '🥟', '#ffd166', '#ef8354'],
  ['Island Kitchen', 'ผัดไทยกุ้งสด', '🍜', '#ffb703', '#fb8500'],
  ['Island Kitchen', 'น้ำเปล่า', '💧', '#a8e6f0', '#2fb5c9'],
  ['Island Kitchen', 'ข้าวเหนียวมะม่วง', '🥭', '#ffe08a', '#f4a259'],
  ['Island Kitchen', 'เบียร์ช้าง', '🍺', '#ffd36b', '#d98e04'],
  ['Island Kitchen', 'แกงเขียวหวานไก่', '🍛', '#b7e4a1', '#5fa86a'],
  ['Island Kitchen', 'ส้มตำไทย', '🥗', '#c9f0a8', '#7bbf4f'],
  ['Island Kitchen', 'ไอศกรีมกะทิ', '🍨', '#ffe3ec', '#f7a8c4'],
  ['Island Kitchen', 'น้ำมะพร้าว', '🥥', '#d9f2e6', '#6cc3a0'],
  ['Island Kitchen', 'ข้าวกะเพราหมูสับ', '🍚', '#ffd1a1', '#e07a5f'],
  ['Island Kitchen', 'ต้มยำกุ้ง', '🍲', '#ffb199', '#e5533d'],
  ['Island Kitchen', 'ปลาทอดราดซอสมะขาม', '🐟', '#ffcf99', '#d1773a'],
  ['Island Kitchen', 'ชาเย็น', '🧋', '#ffc58a', '#e08a3c'],
  ['Island Kitchen', 'น้ำดื่ม 600 มล.', '🚰', '#c4ecf5', '#4fb6cf'],
  ['Breeze Café', 'เอสเปรสโซ', '☕', '#d9b99b', '#8a5a3c'],
  ['Breeze Café', 'ชาเขียวมัทฉะ', '🍵', '#cfeab5', '#79b45a'],
  ['Breeze Café', 'ครัวซองต์เนยสด', '🥐', '#ffe0a3', '#e0a53c'],
  ['Breeze Café', 'ชาไทยเย็น', '🧋', '#ffc58a', '#e08a3c'],
  ['Breeze Café', 'อเมริกาโน่', '☕', '#c9a58a', '#6b4429'],
  ['Breeze Café', 'บราวนี่', '🍫', '#d9b29c', '#7a4a36'],
  ['Breeze Café', 'น้ำส้มคั้น', '🍊', '#ffd699', '#f08a24'],
  ['Breeze Café', 'ลาเต้', '🥛', '#f3e5d3', '#c79a6b'],
  ['Breeze Café', 'แซนด์วิชแฮมชีส', '🥪', '#ffe9b0', '#d9a441'],
  ['Breeze Café', 'คาปูชิโน่', '☕', '#ead7c3', '#a9764d'],
  ['Breeze Café', 'เมล็ดกาแฟคั่ว 250 ก.', '🫘', '#cdb59f', '#5e3b24'],
  ['Sunset Salon', 'ตัดผมชาย', '💈', '#cfe3ff', '#5b8def'],
  ['Sunset Salon', 'ตัดผมหญิง', '✂️', '#ffd6e8', '#e56fa5'],
  ['Sunset Salon', 'สระ ไดร์ จัดทรง', '💇', '#e6d9ff', '#9b7be0'],
  ['Sunset Salon', 'ทำสีผมทั้งศีรษะ', '🎨', '#ffe3b3', '#e86f6f'],
  ['Sunset Salon', 'ทรีตเมนต์บำรุงผม', '💆', '#d6f2e8', '#58b89a'],
  ['Sunset Salon', 'แชมพูสมุนไพร 250 มล.', '🧴', '#d7f0d0', '#6dbb6a'],
  ['Sunset Salon', 'เซรั่มบำรุงผม 50 มล.', '🧴', '#fbe3c8', '#e0955a'],
  ['Lotus Spa', 'นวดไทย 60 นาที', '💆', '#ffe0cc', '#e8896b'],
  ['Lotus Spa', 'นวดไทย 90 นาที', '🙏', '#ffd9c2', '#d96f55'],
  ['Lotus Spa', 'นวดน้ำมัน 60 นาที', '🪔', '#fde6b8', '#d99b3a'],
  ['Lotus Spa', 'นวดเท้า 45 นาที', '🦶', '#d9eef2', '#5fa9b8'],
  ['Lotus Spa', 'อโรมาเธอราปี 90 นาที', '🌸', '#ffdbe9', '#d96fa0'],
  ['Lotus Spa', 'ประคบสมุนไพร 90 นาที', '🌿', '#d3ecc9', '#5f9f56'],
  ['Lotus Spa', 'น้ำมันนวดอโรมา 100 มล.', '🧴', '#f7e0f0', '#b878b0'],
  ['Lotus Spa', 'ลูกประคบสมุนไพร', '🌿', '#cfe9d0', '#58a06a'],
];

const html = (e, c1, c2) => `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;width:640px;height:480px;overflow:hidden}
  body{display:grid;place-items:center;background:radial-gradient(circle at 30% 25%, ${c1}, ${c2});font-family:'Noto Color Emoji',sans-serif}
  .e{font-size:230px;line-height:1;filter:drop-shadow(0 14px 18px rgba(0,0,0,.28))}
  .r{position:absolute;inset:0;background:radial-gradient(circle at 80% 85%, rgba(255,255,255,.35), transparent 45%)}
</style><div class="r"></div><div class="e">${e}</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
const manifest = [];
let i = 0;
for (const [shop, name, emoji, c1, c2] of ITEMS) {
  i += 1;
  const file = `${String(i).padStart(2, '0')}.jpg`;
  await page.setContent(html(emoji, c1, c2));
  await page.screenshot({ path: join(out, file), type: 'jpeg', quality: 78 });
  manifest.push({ store: shop, item: name, file });
}
await browser.close();
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${manifest.length} pictures written to ${out}`);
