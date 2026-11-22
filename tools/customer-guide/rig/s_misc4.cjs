const { T, BASE, open, shot, buttons } = require('./lib.cjs');
const st = (n) => T.stores.find((s) => s.name === n);
const step = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    console.log('FAIL', name, String(e.message).split('\n')[0].slice(0, 160));
  }
};
(async () => {
  const { browser, page } = await open();
  await step('join', async () => {
    await page.goto(`${BASE}/join/koh-phangan`);
    await page.waitForTimeout(2000);
    const ins = page.locator('input:not([type=checkbox]):not([type=hidden])');
    await ins.nth(0).fill('Emma Wilson');
    await ins.nth(1).fill('0891234567');
    await page.getByRole('checkbox').check();
    await shot(page, 'j02-join-filled');
    await page.getByRole('button', { name: 'สร้างบัตร' }).click();
    await page.waitForTimeout(2500);
    await shot(page, 'j02b-join-done', { full: true });
    console.log(
      'join done:',
      (await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 300),
      page.url(),
    );
  });
  await step('cancel', async () => {
    await page.goto(`${BASE}/book/${st('Sunset Salon').book}`);
    await page.waitForTimeout(2200);
    await page.locator('main button').filter({ hasText: /นาที/ }).first().click();
    await page.waitForTimeout(400);
    await page.locator('input[type=date]').fill('2026-11-27');
    await page.waitForTimeout(1500);
    await page
      .locator('main button')
      .filter({ hasText: /^\d\d:\d\d$/ })
      .nth(5)
      .click();
    await page.getByLabel('ชื่อ').fill('Emma Wilson');
    await page.getByLabel('เบอร์โทร').fill('0891234569');
    await page.getByRole('button', { name: 'ยืนยันการจอง' }).click();
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'ยกเลิกการจองนี้' }).click();
    await page.waitForTimeout(1800);
    await shot(page, 's06-cancelled', { full: true });
    console.log(
      'cancel:',
      (await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 300),
    );
  });
  await browser.close();
})();
