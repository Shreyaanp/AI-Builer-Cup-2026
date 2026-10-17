import { expect, test } from '@playwright/test'

test('analytics wrapper requires both a measurement ID and consent', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/', { waitUntil: 'commit' })
  await page.route('https://www.googletagmanager.com/**', (route) => route.abort())
  const result = await page.evaluate(async () => {
    const modulePath = '/src/app/analytics.ts'
    const analytics = await import(/* @vite-ignore */ modulePath)
    analytics.configureAnalytics('', true, 'owner', 'IN')
    analytics.track('onboarding_started')
    const noId = Boolean(document.querySelector('script[src*="googletagmanager.com"]'))
    analytics.setAnalyticsConsent(false)
    analytics.configureAnalytics('G-TEST123', false, 'owner', 'IN')
    analytics.track('onboarding_started')
    const noConsent = Boolean(document.querySelector('script[src*="googletagmanager.com"]'))
    analytics.configureAnalytics('G-TEST123', true, 'owner', 'IN')
    analytics.track('shop_opened', {
      shop_kind: 'Bakery owner name',
      region: 'SG',
      name: 'private',
    })
    history.replaceState(null, '', '/explore/s/demo-private-shop')
    analytics.trackCurrentPage()
    return {
      noId,
      noConsent,
      loaded: Boolean(document.querySelector('script[src*="googletagmanager.com"]')),
      events: (window as Window & { dataLayer?: unknown[] }).dataLayer,
    }
  })
  expect(result.noId).toBe(false)
  expect(result.noConsent).toBe(false)
  expect(result.loaded).toBe(true)
  expect(JSON.stringify(result.events)).not.toContain('Bakery owner name')
  expect(JSON.stringify(result.events)).not.toContain('private')
  expect(JSON.stringify(result.events)).not.toContain('demo-private-shop')
  expect(JSON.stringify(result.events)).toContain('ad_storage')
  expect(JSON.stringify(result.events)).toContain('denied')
})

test('phone: configured GA4 does not request gtag before legal consent', async ({ page }, info) => {
  test.setTimeout(60_000)
  test.skip(info.project.name !== 'phone')
  const gtagRequests: string[] = []
  page.on('request', (request) => {
    if (
      request.url().includes('googletagmanager.com') ||
      request.url().includes('google-analytics.com')
    )
      gtagRequests.push(request.url())
  })
  await page.route('https://www.googletagmanager.com/**', (route) => route.abort())
  await page.route('https://www.google-analytics.com/**', (route) => route.abort())
  // Prime the local session cookie, then let the app see a test-only configured public ID.
  const bootstrap = await page.request.get('/api/v1/bootstrap')
  const config = await bootstrap.json()
  await page.route('**/api/v1/bootstrap', (route) =>
    route.fulfill({ json: { ...config, ga_measurement_id: 'G-TEST123' } }),
  )
  await page.goto('/', { waitUntil: 'commit' })
  await page.getByRole('button', { name: 'Continue local preview' }).click()
  await expect(page.getByRole('button', { name: 'Agree and continue' })).toBeVisible()
  await page.waitForTimeout(300)
  expect(gtagRequests).toEqual([])
})
