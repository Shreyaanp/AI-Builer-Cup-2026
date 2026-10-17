import { expect, test } from '@playwright/test'

const shopId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

test('public shop treats a missing menu collection as empty', async ({ page }) => {
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.fallback() : route.abort()
  })
  await page.addInitScript(() => localStorage.setItem('chalkboard.customer.journey', 'done'))
  await page.route(`**/api/v1/public/shops/${shopId}`, (route) =>
    route.fulfill({ json: { id: shopId, name: 'Safe Shop', products: null } }),
  )
  await page.goto(`/explore/s/${shopId}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Safe Shop' })).toBeVisible()
  await expect(page.getByTestId('menu-coming-soon')).toBeVisible()
})
