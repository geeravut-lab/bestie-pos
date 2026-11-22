const { T, BASE, open, shot, buttons } = require('./lib.cjs');
const st = (n) => T.stores.find((s) => s.name === n);
const tbl = (n) => T.tables.find((t) => t.name === n);
const step = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    console.log('FAIL', name, String(e.message).split('\n')[0].slice(0, 120));
  }
};
(async () => {
  const { browser, page } = await open();
  await step('kb', async () => {
    await page.goto(`${BASE}/kb/${st('Sing Along').kb}`);
    await page.waitForTimeout(2200);
    await shot(page, 'k01-rooms');
    await page.getByText(/VIP 2/).first().click();
    await page.waitForTimeout(500);
    console.log('kb lengths:', (await buttons(page)).slice(6).join(' | '));
    await page.getByRole('button', { name: '120 นาที' }).click();
    await page.locator('input[type=date]').fill('2026-11-27');
    await page.waitForTimeout(1500);
    await shot(page, 'k02-times', { full: true });
    console.log('kb times:', (await buttons(page)).slice(6).join(' | '));
    await page
      .locator('main button')
      .filter({ hasText: /^\d\d:\d\d$/ })
      .nth(4)
      .click();
    await page.getByLabel('ชื่อ').fill('Dan Fischer');
    await page.getByLabel('เบอร์โทร').fill('0899999911');
    await page.getByLabel(/จำนวนคน/).fill('4');
    await shot(page, 'k03-filled', { full: true });
    await page.getByRole('button', { name: 'ยืนยันการจองห้อง' }).click();
    await page.waitForTimeout(2500);
    await shot(page, 'k04-done', { full: true });
    console.log(
      'kb done:',
      (await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 500),
    );
  });
  await browser.close();
})();
