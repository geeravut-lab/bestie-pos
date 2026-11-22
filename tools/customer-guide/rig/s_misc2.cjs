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
(async () => {
  const { browser, page } = await open();
  await step('room', async () => {
    await page.goto(`${BASE}/r/${T.rooms.find((r) => r.name === 'VIP 1').token}`);
    await page.waitForTimeout(2500);
    await shot(page, 'm01-room', { full: true });
    console.log(
      'room:',
      (await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 400),
    );
  });
  await step('kiosk', async () => {
    await page.goto(`${BASE}/t/${tbl('Kiosk 1').token}`);
    await page.waitForTimeout(2200);
    await shot(page, 'o01-kiosk');
    console.log('kiosk buttons:', (await buttons(page)).slice(6, 30).join(' | '));
  });
  await step('web', async () => {
    await page.goto(`${BASE}/t/${tbl('Order online').token}`);
    await page.waitForTimeout(2200);
    await shot(page, 'o11-web');
    console.log(
      'web inputs:',
      (
        await page.$$eval('main input, main textarea', (e) =>
          e
            .filter((x) => x.offsetParent)
            .map((x) => `${x.type}:${x.labels?.[0]?.innerText || x.placeholder}`),
        )
      ).join(' | '),
    );
  });
  await step('info', async () => {
    await page.goto(`${BASE}/t/${tbl('Guest information').token}`);
    await page.waitForTimeout(2200);
    await shot(page, 'i01-info', { full: true });
  });
  await step('join', async () => {
    await page.goto(`${BASE}/join/koh-phangan`);
    await page.waitForTimeout(2000);
    await shot(page, 'j01-join');
    console.log(
      'join inputs:',
      (
        await page.$$eval('main input', (e) =>
          e.map((x) => `${x.type}:${x.labels?.[0]?.innerText}`),
        )
      ).join(' | '),
    );
  });
  await step('pass', async () => {
    await page.goto(`${BASE}/pass/${T.passes[0].token}`);
    await page.waitForTimeout(2500);
    await shot(page, 'j03-pass', { full: true });
  });
  await step('island', async () => {
    await page.goto(`${BASE}/island/koh-phangan`);
    await page.waitForTimeout(2500);
    await shot(page, 'j04-island', { full: true });
  });
  await browser.close();
})();
