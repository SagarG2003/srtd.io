import { expect, test } from '@playwright/test';

test('harness renders with app tokens', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByText('harness ok')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('harness.png'), fullPage: true });
});
