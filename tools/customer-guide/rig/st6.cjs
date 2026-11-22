const { execFileSync } = require('child_process');
const { BASE, shot, buttons } = require('./lib.cjs');
const { login } = require('./st3.cjs');
const q = (sql) =>
  execFileSync(
    'psql',
    ['-h', '/tmp/devpg', '-p', '54998', '-U', 'postgres', '-d', 'demo', '-At', '-F|', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
const ORG = '9dbd7a0f-4cc2-4bb1-8a15-8b6703f369c0';
const jobs = [
  ['salon', 'reception.salon.demo', 'Sunset Salon', 'Front desk', '/calendar', 'Demo'],
  ['spa', 'reception.spa.demo', 'Lotus Spa', 'Front desk', '/calendar', 'Demo'],
  ['retail', 'cashier.retail.demo', 'Island Mart', 'Mart counter', '/sell', 'Demo'],
  ['karaoke', 'cashier.karaoke.demo', 'Sing Along', 'Karaoke desk', '/karaoke', 'Demo'],
  ['tours', 'cashier.tours.demo', 'Island Tours', 'Tour desk', '/tours', 'Demo'],
  ['resort', 'reception.resort.demo', 'Palm Resort', 'Front desk', '/folio', 'Demo'],
  ['cafeq', 'cashier.cafe.demo', 'Breeze Café', 'Café counter', '/queue', 'Demo'],
];
(async () => {
  for (const [key, email, shop, devName, path] of jobs) {
    try {
      const uid = q(`select id from auth.users where email='${email}@bestiedemo.example'`);
      const d = q(
        `select d.id, d.store_id, d.name, d.code, d.role from devices d join stores s on s.id=d.store_id where s.name='${shop}' and d.name='${devName}'`,
      ).split('|');
      const device = {
        deviceId: d[0],
        orgId: ORG,
        storeId: d[1],
        name: d[2],
        code: d[3],
        role: d[4],
        reader: false,
        station: null,
        posId: null,
      };
      const { browser, page } = await login({
        uid,
        email: email + '@bestiedemo.example',
        device,
        pickName: /Demo (Cashier|Reception|Front)/i,
      });
      await page.goto(BASE + path);
      await page.waitForTimeout(3500);
      await shot(page, `h-${key}`);
      console.log(
        key,
        (
          await page
            .locator('main')
            .innerText()
            .catch(() => '')
        )
          .replace(/\s+/g, ' ')
          .slice(0, 160),
      );
      await browser.close();
    } catch (e) {
      console.log('FAIL', key, String(e.message).split('\n')[0].slice(0, 140));
    }
  }
})();
