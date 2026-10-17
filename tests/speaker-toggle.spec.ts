import { expect, test, type Page } from '@playwright/test'

async function openCoach(page: Page, width: number) {
  await page.setViewportSize({ width, height: 800 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Continue local preview' }).click()
  await page.getByLabel('I agree to the Terms').check()
  await page.getByLabel('I have read the Privacy Notice').check()
  await page.getByRole('button', { name: 'Agree and continue' }).click()
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible()
}

for (const width of [360, 390, 412]) {
  test(`speaker toggle is a 48px button that is remembered at ${width}`, async ({ page }) => {
    await openCoach(page, width)
    const on = page.getByRole('button', { name: 'Mute spoken reply' })
    await expect(on).toBeVisible()
    const box = await on.boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(47.5)
    expect(box!.height).toBeGreaterThanOrEqual(47.5)
    await on.click()
    await expect(page.getByRole('button', { name: 'Unmute spoken reply' })).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('ogoogle.speakReplies'))).toBe('0')
    // The composer stays inside the phone width.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    )
  })
}

test('a remembered speaker-off choice is applied on the next visit', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ogoogle.speakReplies', '0'))
  await openCoach(page, 390)
  await expect(page.getByRole('button', { name: 'Unmute spoken reply' })).toBeVisible()
})
