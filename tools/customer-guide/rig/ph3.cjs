const { BASE } = require('./lib.cjs');
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
  await page
    .getByRole('button', { name: /Anna Berg/ })
    .first()
    .click();
  await page.waitForTimeout(2200);
  await page.getByLabel(/เติมเงินสด/).fill('1000');
  await page.getByRole('button', { name: 'รับเงินสดและเติม Credit' }).click();
  await page.waitForTimeout(2500);
  console.log('topped');
  await browser.close();
})();
