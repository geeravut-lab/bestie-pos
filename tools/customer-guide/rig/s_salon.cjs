const { T, BASE, open, shot, buttons } = require('./lib.cjs');
const which = process.argv[2] || 'Sunset Salon';
const pre = which === 'Lotus Spa' ? 'p' : 's';
(async () => {
  const { browser, page } = await open();
  const tok = T.stores.find((s) => s.name === which).book;
  await page.goto(`${BASE}/book/${tok}`);
  await page.waitForTimeout(2200);
  await shot(page, `${pre}01-services`);
  await page.locator('main button').filter({ hasText: /นาที/ }).first().click();
  await page.waitForTimeout(500);
  await page.locator('input[type=date]').fill('2026-11-26');
  await page.waitForTimeout(1500);
  await shot(page, `${pre}02-times`, { full: true });
  const slot = page
    .locator('main button')
    .filter({ hasText: /^\d\d:\d\d$/ })
    .nth(3);
  await slot.click();
  await page.getByLabel('ชื่อ').fill('Emma Wilson');
  await page.getByLabel('เบอร์โทร').fill('0891234567');
  await page.getByLabel(/หมายเหตุ/).fill('ผมยาวประมาณระดับไหล่');
  await shot(page, `${pre}03-filled`, { full: true });
  await page.getByRole('button', { name: 'ยืนยันการจอง' }).click();
  await page.waitForTimeout(2500);
  console.log((await buttons(page)).join(' | '));
  await shot(page, `${pre}04-done-top`);
  await shot(page, `${pre}05-done-full`, { full: true });
  await page.waitForTimeout(500);
  console.log((await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 900));
  await browser.close();
})();
