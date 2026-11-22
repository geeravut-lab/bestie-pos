const { BASE, shot, buttons } = require('./lib.cjs');
const { staffPage, DEV } = require('./staff.cjs');
const step = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    console.log('FAIL', name, String(e.message).split('\n')[0].slice(0, 160));
  }
};
exports.login = async (opts) => {
  const o = await staffPage({
    ...opts,
    viewport:
      process.env.VP === 'tablet' ? { width: 1024, height: 768 } : { width: 390, height: 844 },
  });
  await o.page.goto(BASE + '/');
  await o.page.waitForTimeout(2500);
  await o.page.getByRole('button', { name: opts.pickName }).click();
  await o.page.waitForTimeout(600);
  for (const d of '1234') await o.page.getByRole('button', { name: d, exact: true }).click();
  await o.page.getByRole('button', { name: 'เข้าใช้งาน' }).click();
  await o.page.waitForTimeout(2500);
  return o;
};
if (require.main === module)
  (async () => {
    const { browser, page } = await exports.login({
      uid: '0fb3a6a7-64d5-4884-bcf8-0c56f079c1a3',
      email: 'cashier.cafe.demo@bestiedemo.example',
      device: DEV.cafe,
      pickName: /Demo Cashier/,
    });
    await step('cust', async () => {
      await page.goto(BASE + '/customers');
      await page.waitForTimeout(2500);
      await shot(page, 'c03-customers');
      console.log('cust:', (await buttons(page)).slice(3, 25).join(' | '));
      console.log(
        'inputs:',
        (
          await page.$$eval('input', (e) =>
            e.map((x) => `${x.type}:${x.labels?.[0]?.innerText || x.placeholder}`),
          )
        ).join(' | '),
      );
      await page.locator('input:not([type=hidden])').first().fill('Anna');
      await page.getByRole('button', { name: 'ค้นหา' }).click();
      await page.waitForTimeout(1500);
      await shot(page, 'c04-search');
      console.log('after search:', (await buttons(page)).slice(3, 25).join(' | '));
      await page.getByRole('button', { name: /Anna Berg/ }).click();
      await page.waitForTimeout(2500);
      await shot(page, 'c05-member', { full: true });
      console.log('member:', (await buttons(page)).slice(3, 40).join(' | '));
      console.log((await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 1400));
    });
    await browser.close();
  })();
