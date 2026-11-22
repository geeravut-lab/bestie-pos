const { T, BASE, open, shot, buttons } = require('./lib.cjs');
const st = (n) => T.stores.find((s) => s.name === n);
const tbl = (n) => T.tables.find((t) => t.name === n);
const step = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    console.log('FAIL', name, String(e.message).split('\n')[0].slice(0, 160));
  }
};
const addItem = async (page, re) => {
  await page.getByRole('button', { name: re }).first().click();
  await page.waitForTimeout(500);
  const add = page.getByRole('button', { name: /ใส่ตะกร้า/ });
  if (await add.count()) await add.click();
  await page.waitForTimeout(500);
};
(async () => {
  const { browser, page } = await open();
  await step('kiosk', async () => {
    await page.goto(`${BASE}/t/${tbl('Kiosk 1').token}`);
    await page.waitForTimeout(2200);
    await page.getByRole('button', { name: /ลาเต้/ }).first().click();
    await page.waitForTimeout(700);
    await shot(page, 'o02-kiosk-options');
    console.log('latte sheet:', (await buttons(page)).slice(-12).join(' | '));
    await page.getByText('นมวัว').click();
    await page.getByText('หวานน้อย').click();
    await page.getByText(/ช็อตวานิลลา/).click();
    await shot(page, 'o02b-kiosk-options-chosen');
    await page.getByRole('button', { name: /ใส่ตะกร้า/ }).click();
    await page.waitForTimeout(500);
    await addItem(page, /ครัวซองต์/);
    await shot(page, 'o03-kiosk-basket');
    console.log('kiosk after:', (await buttons(page)).slice(-6).join(' | '));
    console.log('ALL:', (await buttons(page)).slice(30).join(' | '));
    await page
      .getByRole('button', { name: /^(ส่งออเดอร์|สั่งอาหาร|ยืนยัน)/ })
      .first()
      .click();
    await page.waitForTimeout(2200);
    await shot(page, 'o04-kiosk-number');
    console.log(
      'kiosk done:',
      (await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 300),
    );
  });
  await step('web', async () => {
    await page.goto(`${BASE}/t/${tbl('Order online').token}`);
    await page.waitForTimeout(2200);
    await addItem(page, /อเมริกาโน่/);
    await addItem(page, /บราวนี่/);
    await shot(page, 'o12-web-basket');
    await page.getByLabel('ชื่อของคุณ').fill('Emma Wilson');
    await page.getByLabel(/เบอร์โทร/).fill('0891234567');
    await shot(page, 'o13-web-filled');
    await page
      .getByRole('button', { name: /^(ส่งออเดอร์|สั่งอาหาร)/ })
      .first()
      .click();
    await page.waitForTimeout(2200);
    await shot(page, 'o14-web-done');
    console.log(
      'web done:',
      (await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 300),
    );
    console.log(
      'web inputs:',
      (
        await page.$$eval('input, textarea', (e) =>
          e
            .filter((x) => x.offsetParent)
            .map(
              (x) =>
                `${x.type}:${x.labels?.[0]?.innerText || x.placeholder || x.getAttribute('aria-label')}`,
            ),
        )
      ).join(' | '),
    );
  });
  await browser.close();
})();
