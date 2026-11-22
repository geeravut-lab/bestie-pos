const { BASE, buttons, shot } = require('./lib.cjs');
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
    uid: '0fb3a6a7-64d5-4884-bcf8-0c56f079c1a3',
    email: 'cashier.cafe.demo@bestiedemo.example',
    device: DEV.cafe,
    pickName: /Demo Cashier/,
  });
  const panel = async (name, tall) => {
    await page.evaluate(() =>
      document.querySelectorAll('*').forEach((e) => {
        const p = getComputedStyle(e).position;
        if (p === 'fixed' || p === 'sticky') e.style.visibility = 'hidden';
      }),
    );
    const b = await page.getByText('Bestie Credit (มูลค่าเติมเงิน)', { exact: true }).boundingBox();
    const y = await page.evaluate((top) => top + window.scrollY, b.y);
    await page.screenshot({
      path: `/tmp/cm/shots/${name}.png`,
      fullPage: true,
      clip: { x: 0, y: Math.max(0, y - 20), width: 390, height: tall },
    });
    console.log('shot', name);
  };
  await step('new', async () => {
    await page.goto(BASE + '/customers');
    await page.waitForTimeout(2200);
    await page.getByRole('button', { name: 'เพิ่มสมาชิกใหม่' }).click();
    await page.waitForTimeout(600);
    await shot(page, 'e01-newmember');
    await page.getByLabel('ชื่อ', { exact: true }).fill('Eva Lund');
    await page.getByLabel(/เบอร์โทร/).fill('0891234574');
    await shot(page, 'e02-newmember-filled');
    await page.getByRole('button', { name: 'เพิ่มสมาชิก', exact: true }).click();
    await page.waitForTimeout(2500);
    await panel('d01-credit-terms', 1150);
    await page.getByText(/ลูกค้าอ่านและยอมรับข้อกำหนด/).click();
    await page.getByRole('button', { name: 'บันทึกการยอมรับ' }).click();
    await page.waitForTimeout(2000);
    await panel('d02-credit-accepted', 900);
    await page.getByLabel(/เติมเงินสด/).fill('500');
    await page.getByRole('button', { name: 'รับเงินสดและเติม Credit' }).click();
    await page.waitForTimeout(2500);
    await panel('d03-credit-topped', 900);
  });
  await browser.close();
})();
