const { BASE, shot } = require('./lib.cjs');
const { DEV } = require('./staff.cjs');
const { login } = require('./st3.cjs');
(async () => {
  const { browser, page } = await login({
    uid: '0fb3a6a7-64d5-4884-bcf8-0c56f079c1a3',
    email: 'cashier.cafe.demo@bestiedemo.example',
    device: DEV.cafe,
    pickName: /Demo Cashier/,
  });
  await page.goto(BASE + '/customers');
  await page.waitForTimeout(2200);
  await page.getByLabel('ค้นหาสมาชิก').fill('Anna Berg');
  await page.getByRole('button', { name: 'ค้นหา' }).click();
  await page.waitForTimeout(1200);
  await shot(page, 'z01-search');
  await page
    .getByRole('button', { name: /Anna Berg/ })
    .first()
    .click();
  await page.waitForTimeout(2200);
  await page.getByText('ประวัติแต้ม').first().scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -120));
  await shot(page, 'z02-member-points');
  await page.getByText('Bestie Credit (มูลค่าเติมเงิน)', { exact: true }).scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -80));
  await shot(page, 'z03-member-credit');
  await browser.close();
})();
