import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { english, translations } from '../src/features/discover/strings.ts'
import { LOCALES } from '../src/i18n/locales.ts'

test('discovery treats a missing places collection as empty', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('chalkboard.customer.journey', 'done'))
  await page.route('**/api/v1/discover?**', (route) => route.fulfill({ json: { mode: 'live' } }))
  await page.goto('/discover')
  await expect(page.getByText('No matches. Try another area or clear your filters.')).toBeVisible()
})

async function offline(page: Page) {
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.fallback() : route.abort()
  })
}

async function shop(page: Page, name: string, open: boolean) {
  await page.request.get('/api/v1/bootstrap')
  const me = await (await page.request.get('/api/v1/me')).json()
  expect(
    (
      await page.request.post('/api/v1/consent', {
        data: { version: me.legal_version, terms: true, privacy: true },
      })
    ).ok(),
  ).toBeTruthy()
  const hour = (new Date().getUTCHours() + 8) % 24
  const hours = open
    ? `${(hour + 23) % 24}:00–${(hour + 1) % 24}:59`
    : `${(hour + 6) % 24}:00–${(hour + 7) % 24}:00`
  const prepared = await page.request.post('/api/v1/proposals', {
    data: {
      kind: 'business',
      geocode_confirmed: true,
      business: { name, category: 'Kopi', location: 'Tiong Bahru Market', hours, currency: 'SGD' },
      products: [
        { name: 'Teh tarik', price: 220, unit: 'cup' },
        { name: 'Kaya toast', price: 240, unit: 'set', available: false },
      ],
    },
  })
  expect(prepared.ok()).toBeTruthy()
  const proposal = await prepared.json()
  const saved = await page.request.post(`/api/v1/proposals/${proposal.id}/approve`, {
    data: { digest: proposal.digest },
  })
  expect(saved.ok()).toBeTruthy()
  const id = (await saved.json()).business_id as string
  expect(
    (await page.request.post(`/api/v1/businesses/${id}/share`, { data: { public: true } })).ok(),
  ).toBeTruthy()
  return id
}

test.beforeEach(async ({ page }, info) => {
  // Each scenario represents a separate public customer, including the 30/minute IP limit.
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `fixture-discover-${info.testId}` })
  await offline(page)
  // This suite exercises the returning feed; first-run guidance has its own journey spec.
  await page.addInitScript(() => localStorage.setItem('chalkboard.customer.journey', 'done'))
})

test('search, category, open-now, sold-out and anonymous customer page', async ({ page }, info) => {
  const name = `Discovery ${info.project.name} Kopi ${Date.now()}`
  const id = await shop(page, name, true)
  await page.context().clearCookies()
  await page.goto('/discover')
  await expect(page.getByRole('heading', { name: 'What’s around me?' })).toBeVisible()
  await expect(page.getByText('Demo data', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /sign in/i })).toHaveCount(0)
  await page.getByRole('button', { name: 'Bakery', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Tiong Bahru Bakery' })).toBeVisible()
  await expect(page.getByRole('heading', { name })).toHaveCount(0)
  await page.getByRole('switch', { name: 'Open now', exact: true }).check()
  await expect(page.getByText('No matches. Try another area or clear your filters.')).toBeVisible()
  await page.getByRole('button', { name: 'Bakery', exact: true }).click()
  await page.getByRole('button', { name: 'Coffee & tea', exact: true }).click()
  await page.getByLabel('Search nearby').fill(name)
  await page.getByLabel('Search nearby').press('Enter')
  const card = page.getByRole('list').getByRole('link').filter({ hasText: name })
  await expect(card).toBeVisible()
  // Cards show the first dish only; sold-out detail lives on the shop page.
  await expect(card).toContainText('Teh tarik')
  await expect(card).toContainText(/\$2\.20/)
  await expect(card).toContainText('Open now')
  expect(await card.getAttribute('href')).toBe(`/explore/s/${id}`)
  await card.click()
  await expect(page).toHaveURL(new RegExp(`/explore/s/${id}$`))
  await expect(page.getByRole('heading', { name })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Your usuals' })).toBeVisible()
  await expect(page.getByLabel('Search nearby')).toHaveValue(name)
  await expect(page.getByRole('switch', { name: 'Open now', exact: true })).toBeChecked()
})

test('Google sheet, live directions link, lazy fixture map, area and known-only halal', async ({
  page,
}) => {
  let googleRequests = 0
  page.on('request', (request) => {
    if (/googleapis\.com|google\.com/.test(request.url())) googleRequests++
  })
  await page.goto('/discover')
  await page
    .getByRole('list')
    .getByRole('button', { name: /Tiong Bahru Bakery/ })
    .click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText('Demo data', { exact: false })).toBeVisible()
  await expect(
    sheet.getByRole('link', { name: 'Open in Google Maps · Live link' }),
  ).toHaveAttribute('href', /^https:\/\/www.google.com\/maps\//)
  await sheet.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Map view', exact: true }).click()
  await expect(page.getByRole('button', { name: 'List view', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'List view', exact: true }).click()
  expect(googleRequests).toBe(0)
  await page.getByRole('switch', { name: 'Halal if known' }).check()
  await expect(page.getByText('No matches. Try another area or clear your filters.')).toBeVisible()
  await page.getByRole('switch', { name: 'Halal if known' }).uncheck()
  // Any city or neighbourhood worldwide; demo mode knows the fixture areas.
  await page.getByRole('textbox', { name: 'City or area' }).fill('Tampines')
  await page.getByRole('textbox', { name: 'City or area' }).press('Enter')
  await expect(page.getByText('No matches. Try another area or clear your filters.')).toBeVisible()
  await page.reload()
  // A remembered place collapses to its label with a Change area button.
  await page.getByRole('button', { name: 'Change area' }).click()
  await expect(page.getByRole('textbox', { name: 'City or area' })).toHaveValue('Tampines')
  await page.route('**/api/v1/discover?**', (route) =>
    route.fulfill({ json: { mode: 'live', places: [] } }),
  )
  await page.reload()
  await page.getByRole('button', { name: 'Tiong Bahru Bakery', exact: true }).click()
  // A saved fixture usual keeps its disclosure when configuration later becomes live.
  await expect(page.getByRole('dialog').getByText('Demo data', { exact: false })).toBeVisible()
})

test('GPS explanation, denial fallback, budget and recovery', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      value: {
        getCurrentPosition: (_success: unknown, error: (value: { code: number }) => void) =>
          error({ code: 1 }),
      },
    })
  })
  await page.goto('/discover')
  await expect(
    page.getByText('Use your location to find nearby shops. Choose an area if you prefer.'),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Use my location' }).click()
  await expect(page.getByText('Location unavailable. Please choose an area.')).toBeVisible()
  await page.getByRole('switch', { name: /Budget/ }).check()
  await expect(page.getByRole('heading', { name: 'Tiong Bahru Bakery' })).toHaveCount(0)
  await page.route('**/api/v1/discover?**', (route) =>
    route.fulfill({ status: 503, json: { detail: 'fixture unavailable' } }),
  )
  await page.getByLabel('Search nearby').fill('error fixture')
  await page.getByLabel('Search nearby').press('Enter')
  await expect(page.getByText('Couldn’t load nearby places. Please retry.')).toBeVisible()
  await page.unroute('**/api/v1/discover?**')
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByText('No matches. Try another area or clear your filters.')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
})

for (const mode of ['light', 'dark'] as const) {
  test(`axe ${mode}, text scaling and keyboard`, async ({ page }, info) => {
    if (info.project.name === 'phone') await page.setViewportSize({ width: 412, height: 915 })
    await page.emulateMedia({ colorScheme: mode, reducedMotion: 'reduce' })
    await page.goto('/discover')
    await expect(page.getByRole('heading', { name: 'Tiong Bahru Bakery' })).toBeVisible()
    await page.screenshot({ path: info.outputPath('discover.png'), fullPage: true })
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '24px'
    })
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy()
    const report = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze()
    expect(report.violations).toEqual([])
    await page.getByLabel('Search nearby').focus()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeFocused()
    await page
      .getByRole('list')
      .getByRole('button', { name: /Tiong Bahru Bakery/ })
      .click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.screenshot({ path: info.outputPath('discover-sheet.png') })
    const dialogReport = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze()
    expect(dialogReport.violations).toEqual([])
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
}

test('phone language and complete translations', async ({ page }) => {
  for (const locale of LOCALES.filter((value) => value !== 'en')) {
    expect(Object.keys(translations[locale] ?? {})).toEqual(Object.keys(english))
    for (const text of Object.values(translations[locale] ?? {})) expect(typeof text).toBe('string')
  }
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'languages', { value: ['ms-SG'] })
  })
  await page.goto('/discover')
  await expect(page.getByRole('heading', { name: 'Apa yang berdekatan?' })).toBeVisible()
  await expect(page.getByLabel('Cari berdekatan')).toBeVisible()
  await expect(page.getByText('Data demo', { exact: true })).toBeVisible()
})

test('global category chips, legacy links and B22 phone screenshot', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/discover?category=kopi')
  const coffee = page.getByRole('button', { name: 'Coffee & tea', exact: true })
  await expect(coffee).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('heading', { name: 'Tiong Bahru Kopi' })).toBeVisible()
  await expect(page).toHaveURL(/category=coffee/)
  for (const name of [
    'Coffee & tea',
    'Food',
    'Bakery',
    'Groceries',
    'Pharmacy',
    'Hardware',
    'Fashion',
    'Beauty',
    'Services',
    'Other',
  ]) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1)
  }
  await expect(page.getByRole('button', { name: 'Kopi', exact: true })).toHaveCount(0)
  if (info.project.name === 'phone') {
    await coffee.evaluate((element) => element.scrollIntoView({ block: 'start' }))
    await page.screenshot({ path: 'docs/bugs/B22.png', animations: 'disabled' })
  }
  await page.goto('/discover?category=hawker')
  await expect(page.getByRole('button', { name: 'Food', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByRole('heading', { name: 'Chinatown Hawker Centre' })).toBeVisible()
  await expect(page).toHaveURL(/category=food/)
  const invalidCategories = await page.evaluate(async () => {
    const path = '/src/features/discover/categories.ts'
    const { categoryValue } = await import(path)
    return [null, 123, 'constructor', '__proto__', 'unknown'].map(categoryValue)
  })
  expect(invalidCategories).toEqual(['', '', '', '', ''])
})
