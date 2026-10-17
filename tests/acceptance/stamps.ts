import { expect, type Page } from '@playwright/test'

/** The count on the shop button, the stamp card and the passport: all the same number. */
export async function expectCount(
  page: Page,
  shopUrl: URL,
  name: string,
  count: number,
  needed: number,
  inPassport = true,
) {
  await page.goto(shopUrl.toString())
  const card = page.getByRole('region', { name: 'Stamp card' })
  await expect(page.getByRole('link', { name: /^Stamp card · / })).toHaveText(
    `Stamp card · ${count} of ${needed} stamps`,
  )
  await expect(card.getByRole('status')).toHaveText(`${count} stamps`)
  await expect(card.getByRole('img', { name: `${count} of ${needed} stamps` })).toBeVisible()
  // The passport lists only shops the customer has been stamped at (not the welcome stamps alone).
  if (!inPassport) return
  await page.goto(`${shopUrl.origin}/explore/passport`)
  await expect(page.locator('li').filter({ hasText: name })).toContainText(
    `${count} of ${needed} stamps`,
    { timeout: 15_000 },
  )
}
