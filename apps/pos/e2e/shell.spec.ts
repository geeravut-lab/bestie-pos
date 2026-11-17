import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const isPhone = (name: string) => name === 'phone';

async function open(page: Page, lang: 'th' | 'en' = 'th', path = '/') {
  await page.addInitScript((l) => {
    try {
      localStorage.setItem('bestie-lang', l);
      localStorage.setItem('bestie-preview-profile', 'restaurant');
    } catch {
      /* ignore */
    }
  }, lang);
  await page.goto(path);
  await page.waitForSelector('main');
}

test.describe('shell layout', () => {
  test('never scrolls sideways and has the right navigation for the screen', async ({
    page,
  }, info) => {
    await open(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    if (isPhone(info.project.name)) {
      await expect(page.locator('.bar')).toBeVisible();
      await expect(page.locator('.sidebar')).toBeHidden();
    } else {
      await expect(page.locator('.sidebar')).toBeVisible();
      await expect(page.locator('.bar')).toBeHidden();
    }
  });

  test('bottom bar: 5 equal slots, every tap target ≥ 44px, raised centre action, does not hide the last card', async ({
    page,
  }, info) => {
    test.skip(!isPhone(info.project.name));
    await open(page);
    const items = page.locator('.bar > *');
    expect(await items.count()).toBe(5);
    const boxes = await items.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
    for (const b of boxes) expect(b.width).toBeCloseTo(boxes[0]!.width, 0);
    for (const el of await page.locator('.bar a, .bar button').all()) {
      expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    const disc = (await page.locator('.bar-center-disc').boundingBox())!;
    const bar = (await page.locator('.bar').boundingBox())!;
    expect(disc.y).toBeLessThan(bar.y); // raised above the bar
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const lastCard = (await page.locator('.nav-card').last().boundingBox())!;
    expect(lastCard.y + lastCard.height).toBeLessThanOrEqual(bar.y + 1);
  });

  test('"More" sheet opens, closes with Esc and with the device Back button', async ({
    page,
  }, info) => {
    test.skip(!isPhone(info.project.name));
    await open(page);
    await page.getByRole('button', { name: 'เพิ่มเติม' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect((await page.locator('.sheet').boundingBox())!.height).toBeLessThanOrEqual(
      844 * 0.85 + 1,
    );
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();

    await page.getByRole('button', { name: 'เพิ่มเติม' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('dialog')).toBeHidden();
    expect(new URL(page.url()).pathname).toBe('/'); // Back closed the sheet, did not leave the page
  });

  test('module-off cards stay visible but are grey and cannot be opened', async ({ page }) => {
    await open(page); // cashier + restaurant: no queue module
    const queue = page.locator('.nav-card', { hasText: 'คิว' });
    await expect(queue).toHaveAttribute('aria-disabled', 'true');
    await queue.click({ force: true });
    expect(new URL(page.url()).pathname).toBe('/');
    await page.getByRole('button', { name: 'คาเฟ่' }).click();
    await expect(page.locator('.nav-card', { hasText: 'คิว' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  test('navigating shows the page and a back link home; language switch changes copy and <html lang>', async ({
    page,
  }) => {
    await open(page, 'th', '/orders');
    await expect(page.getByRole('link', { name: /กลับไปหน้าแรก/ })).toBeVisible();
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.getByRole('link', { name: /Back to Home/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
  });

  test('role chips switch the home cards', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'ครัวและบาร์' }).click();
    await expect(page.locator('.nav-card')).toHaveCount(1);
    await expect(page.locator('.nav-card', { hasText: 'จอครัว' })).toBeVisible();
  });
});

for (const lang of ['th', 'en'] as const) {
  test(`accessibility (axe, WCAG A/AA) — home and sub page, ${lang}`, async ({ page }) => {
    for (const path of ['/', '/orders']) {
      await open(page, lang, path);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(
        results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 80)}`),
        `${lang} ${path}`,
      ).toEqual([]);
    }
  });
}
