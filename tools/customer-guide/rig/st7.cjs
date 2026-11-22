const { BASE, shot } = require('./lib.cjs');
const { DEV } = require('./staff.cjs');
const { login } = require('./st3.cjs');
const step = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    console.log('FAIL', name, String(e.message).split('\n')[0].slice(0, 160));
  }
};
(async () => {
  let o = await login({
    uid: '0fb3a6a7-64d5-4884-bcf8-0c56f079c1a3',
    email: 'cashier.cafe.demo@bestiedemo.example',
    device: DEV.cafe,
    pickName: /Demo Cashier/,
  });
  await step('qd', async () => {
    await o.page.goto(BASE + '/queue/display');
    await o.page.waitForTimeout(3000);
    await shot(o.page, 'h-queue-display');
  });
  await o.browser.close();
  o = await login({
    uid: '1f70c9f5-f90f-4b18-a177-ed8220c2c706',
    email: 'cashier.kitchen.demo@bestiedemo.example',
    device: DEV.kitchen,
    pickName: /Demo Cashier/,
  });
  const page = o.page;
  await step('room', async () => {
    await page.goto(BASE + '/sell');
    await page.waitForTimeout(2200);
    await page.getByRole('button', { name: 'เปิดออเดอร์ใหม่' }).click();
    await page.waitForTimeout(2200);
    await page
      .getByRole('button', { name: /น้ำเปล่า/ })
      .first()
      .click();
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: 'รับเงิน' }).click();
    await page.waitForTimeout(1500);
    await page.getByText('ลงห้องพัก', { exact: true }).last().click();
    await page.waitForTimeout(1500);
    await shot(page, 'x10-room');
    console.log((await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(-400));
  });
  await o.browser.close();
})();
