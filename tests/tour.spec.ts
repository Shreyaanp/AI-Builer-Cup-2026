import { expect, test } from '@playwright/test'

// First visit: a guided tour on a filled demo shop (menu + eight weeks of sales).
test.skip(({ isMobile }) => !isMobile, '390×844 phone story')

test('guided tour: demo shop is created, eight spotlights, then start your own', async ({
  page,
}) => {
  await page.route('**/*', (route) =>
    ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
      ? route.continue()
      : route.abort(),
  )
  await page.goto('/')
  await page.getByRole('button', { name: 'Continue local preview' }).tap()
  await page.getByLabel('I agree to the Terms').check()
  await page.getByLabel('I have read the Privacy Notice').check()
  await page.getByRole('button', { name: 'Agree and continue' }).tap()
  await expect(page.getByText('See it working first')).toBeVisible()
  await page.screenshot({ path: 'docs/stories/T-0-offer.png' })
  await page.getByRole('button', { name: 'Take the tour' }).tap()
  const tour = page.getByRole('dialog', { name: 'Your shop at a glance' })
  await expect(tour).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(800)
  await page.screenshot({ path: 'docs/stories/T-1-shop.png' })
  const titles = [
    'Your menu, by category',
    'Tomorrow’s prep plan',
    'Close the day in a minute',
    'Running low? Find suppliers',
    'Just talk or type',
    'Get on Google, guided',
    'Share your page',
  ]
  for (const [index, title] of titles.entries()) {
    await page.getByRole('button', { name: 'Next', exact: true }).tap()
    await expect(page.getByRole('dialog', { name: title })).toBeVisible()
    if (index === 1 || index === 4) {
      await page.waitForTimeout(700)
      await page.screenshot({ path: `docs/stories/T-${index + 2}-spotlight.png` })
    }
  }
  await page.getByRole('button', { name: 'Next', exact: true }).tap()
  await expect(page.getByRole('dialog', { name: 'You’re ready' })).toBeVisible()
  await page.getByRole('button', { name: 'Keep exploring' }).tap()
  await expect(page.getByRole('dialog', { name: /You’re ready/ })).toHaveCount(0)
  // The demo shop stays private and clearly named.
  await expect(page.getByRole('button', { name: /Choose shop: .*\(Tour\)/ })).toBeVisible()
})
