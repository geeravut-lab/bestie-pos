import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const TOKEN = 'a'.repeat(32);
const MENU = {
  store: { name: 'Acme Kitchen' },
  table: { name: 'T1' },
  autoSend: false,
  menu: {
    categories: [{ id: 'c1', name: { th: 'จานหลัก', en: 'Mains' } }],
    items: [
      {
        id: 'i1',
        category_id: 'c1',
        name: { th: 'ผัดไทย', en: 'Pad Thai' },
        price: 18000,
        group_ids: ['g1'],
      },
      {
        id: 'i2',
        category_id: 'c1',
        name: { th: 'น้ำเปล่า', en: 'Water' },
        price: 2000,
        group_ids: [],
      },
    ],
    groups: [
      {
        id: 'g1',
        name: { th: 'เผ็ด', en: 'Spice' },
        min: 1,
        max: 1,
        options: [
          { id: 'o1', name: { th: 'น้อย', en: 'Mild' }, delta: 0 },
          { id: 'o2', name: { th: 'มาก', en: 'Hot' }, delta: 500 },
        ],
      },
    ],
  },
  bill: { order_id: null, lines: [] },
};

async function openGuest(page: Page, lang: 'th' | 'en') {
  await page.addInitScript((l) => localStorage.setItem('bestie-lang', l), lang);
  await page.route('**/api/guest/menu*', (route) => route.fulfill({ json: MENU }));
  await page.route('**/api/guest/order', (route) =>
    route.fulfill({ json: { order_id: 'o', number: 'QR001', lines: 1, status: 'waiting' } }),
  );
  await page.goto(`/t/${TOKEN}`);
  await page.waitForSelector('.guest-page');
}

test.describe('guest table QR page', () => {
  test('order from a phone: choose a dish, pick a required option, place the order', async ({
    page,
  }) => {
    await openGuest(page, 'en');
    await expect(page.getByRole('heading', { name: 'Acme Kitchen' })).toBeVisible();
    await page.getByRole('button', { name: /Pad Thai/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: /Add to basket/ })).toBeDisabled();
    await dialog.getByLabel(/Hot/).check();
    await dialog.getByRole('button', { name: /Add to basket/ }).click();
    await page.getByRole('button', { name: /Place order/ }).click();
    await expect(page.getByText('Order sent')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  for (const lang of ['th', 'en'] as const) {
    test(`accessibility (axe, WCAG A/AA) — ${lang}`, async ({ page }) => {
      await openGuest(page, lang);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 80)}`)).toEqual(
        [],
      );
    });
  }
});
