// pay with Credit at another shop (phone layout)
const { BASE, shot, buttons } = require('./lib.cjs');
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
  const { browser, page } = await login({
    uid: '1f70c9f5-f90f-4b18-a177-ed8220c2c706',
    email: 'cashier.kitchen.demo@bestiedemo.example',
    device: DEV.kitchen,
    pickName: /Demo Cashier/,
  });
  await page.goto(BASE + '/sell');
  await page.waitForTimeout(2500);
  await shot(page, 'y01-sell');
  await page.getByRole('button', { name: 'เปิดออเดอร์ใหม่' }).click();
  await page.waitForTimeout(2500);
  await shot(page, 'y02-order');
  await step('items', async () => {
    await page.getByRole('button', { name: /ผัดไทยกุ้งสด/ }).click();
    await page.waitForTimeout(700);
    const add = page.getByRole('button', { name: /ใส่ตะกร้า|เพิ่มลงบิล|เพิ่มรายการ/ });
    if (await add.count()) await add.first().click();
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: /ชาเย็น/ }).first().click();
    await page.waitForTimeout(700);
    console.log('btns', (await buttons(page)).slice(0, 12).join(' | '));
  });
  await step('cust', async () => {
    await page.getByRole('button', { name: 'ใส่ลูกค้าในบิล' }).click();
    await page.waitForTimeout(800);
    await page.getByLabel('ค้นหาสมาชิก').fill('Anna Berg');
    await page.getByRole('button', { name: 'ค้นหา' }).click();
    await page.waitForTimeout(1500);
    await shot(page, 'y03-cust');
    await page
      .getByRole('button', { name: /Anna Berg/ })
      .first()
      .click();
    await page.waitForTimeout(2000);
    await shot(page, 'y04-attached');
  });
  await step('pay', async () => {
    await page.getByRole('button', { name: 'รับเงิน' }).click();
    await page.waitForTimeout(2000);
    await shot(page, 'y05-pay');
    await page.getByText('แยกจ่าย', { exact: true }).last().click();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: 'หารเท่ากัน' }).click();
    await page.waitForTimeout(900);
    await page.getByLabel('จ่ายด้วย 1').selectOption({ label: 'Credit' });
    await page.waitForTimeout(500);
    await shot(page, 'y06-split-credit');
    await page
      .getByLabel(/รับเงินมาจากคนที่ 2/)
      .fill('130')
      .catch(() => {});
    await page.getByRole('button', { name: 'รับเงินและปิดบิล' }).click();
    await page.waitForTimeout(3500);
    await page.evaluate(() => window.scrollTo(0, 520));
    await shot(page, 'y07-receipt');
    console.log(page.url());
  });
  await browser.close();
})();
