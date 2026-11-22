const {
  chromium,
} = require('/home/user/bestie-pos/node_modules/.pnpm/playwright@1.63.0/node_modules/playwright');
const T = require('/tmp/cm/tokens.json');
exports.T = T;
exports.BASE = 'http://127.0.0.1:54321';
exports.open = async (opts = {}) => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    locale: 'th-TH',
    ...opts,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', String(e).slice(0, 200)));
  await page.addInitScript(() => {
    try {
      localStorage.setItem('bestie-guest-lang', 'th');
      localStorage.setItem('bestie-lang', 'th');
    } catch {}
  });
  return { browser, ctx, page };
};
exports.shot = async (page, name, o = {}) => {
  await page.waitForTimeout(o.wait ?? 700);
  await page.screenshot({ path: `/tmp/cm/shots/${name}.png`, fullPage: !!o.full, type: 'png' });
  console.log('shot', name);
};
exports.buttons = async (page) =>
  (
    await page.$$eval('button, a.btn, [role=button]', (els) =>
      els
        .filter((e) => e.offsetParent)
        .map((e) =>
          (e.innerText || e.getAttribute('aria-label') || '')
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 40),
        ),
    )
  ).filter(Boolean);
