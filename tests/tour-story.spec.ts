import { AxeBuilder } from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { enter } from './stories/support.js'

test.beforeEach(async ({ page, isMobile }) => {
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 })
  await page.route('**/*', (route) =>
    ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
      ? route.continue()
      : route.abort(),
  )
  await page.addInitScript(() => localStorage.setItem('chalkboard.customer.journey', 'done'))
})

for (const appearance of ['light', 'dark']) {
  for (const world of [
    {
      city: 'bengaluru',
      slug: 'chai',
      name: 'Lantern Chai Corner (Demo)',
      item: 'Masala chai',
      price: '₹20.00',
    },
    {
      city: 'singapore',
      slug: 'kopi',
      name: 'Sunny Side Kopitiam (Demo)',
      item: 'Kopi',
      price: '$1.70',
    },
  ]) {
    test(`${world.city} shop: authored menu and demo badge (${appearance})`, async ({
      page,
    }, info) => {
      // The customer shop is a large lazy-loaded immersive screen. On a cold Vite
      // start its first compilation can outlast the default 30 second test budget.
      test.setTimeout(60_000)
      await page.addInitScript((appearance) => {
        localStorage.setItem('niva.starter.preferences', JSON.stringify({ appearance }))
      }, appearance)
      await page.goto(`/explore/s/demo-story-${world.city}-${world.slug}`)
      await expect(page.getByRole('heading', { name: world.name, exact: true })).toBeVisible()
      await expect(page.getByText(world.item, { exact: true }).first()).toBeVisible()
      await expect(page.getByText(world.price, { exact: false }).first()).toBeVisible()
      const badge = page.getByRole('button', { name: 'Verified owner · Demo shop' })
      await badge.click()
      await expect(
        page.getByText('Demo badge only. No identity or business check was performed.'),
      ).toBeVisible()
      await expect(page.locator('img').first()).toBeVisible()
      expect(
        await page
          .locator('img')
          .first()
          .evaluate((el) => (el as HTMLImageElement).naturalWidth),
      ).toBeGreaterThan(0)
      await page.screenshot({
        path: `output/playwright/tour-story/${info.project.name}-${world.city}-${appearance}.png`,
        fullPage: true,
        animations: 'disabled',
      })
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
      ).toEqual([])
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBeTruthy()
    })
  }
}

for (const area of [
  {
    city: 'bengaluru',
    slug: 'chai',
    lat: 12.9718,
    lng: 77.6412,
    label: 'Indiranagar, Bengaluru',
    query: 'masala chai',
    price: '₹20.00',
  },
  {
    city: 'singapore',
    slug: 'kopi',
    lat: 1.3052,
    lng: 103.9045,
    label: 'Katong, Singapore',
    query: 'kopi',
    price: '$1.70',
  },
]) {
  test(`${area.city} front door leads to local prices and map pins`, async ({ page }, info) => {
    await page.addInitScript((place) => {
      localStorage.setItem('chalkboard.discover.filters', JSON.stringify({ place }))
    }, area)
    await page.goto('/explore/')
    await expect(page.getByRole('button', { name: `Area: ${area.label}` })).toBeVisible()
    await expect(
      page.getByRole('list', { name: 'Ask about anything nearby' }).getByRole('button').first(),
    ).toBeVisible()
    await page.screenshot({
      path: `output/playwright/tour-story/${info.project.name}-${area.city}-front-door.png`,
      animations: 'disabled',
    })
    await page.getByRole('textbox', { name: 'Ask about anything nearby' }).fill(area.query)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const shop = page.locator(`a[href="/explore/s/demo-story-${area.city}-${area.slug}"]`).first()
    await expect(shop).toContainText(area.price, { timeout: 15_000 })
    await expect(page.getByRole('group', { name: 'Map of these places' })).toBeVisible()
    await page.screenshot({
      path: `output/playwright/tour-story/${info.project.name}-${area.city}-map.png`,
      fullPage: true,
      animations: 'disabled',
    })
  })
}

test('customer opts into the seeded story, then sees passport and replied chats', async ({
  page,
}, info) => {
  test.setTimeout(60_000)
  await page.request.post('/api/v1/customer/session', { data: { name: 'Demo judge' } })
  await page.goto('/explore/')
  await page.getByRole('button', { name: 'Profile and preferences' }).click()
  await page.getByRole('button', { name: 'Load demo story' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const passport = await (await page.request.get('/api/v1/customer/passport')).json()
  expect(passport.points).toBe(0)
  expect(passport.demo_points).toBeGreaterThan(0)
  expect(passport.impact.co2_kg).toBeGreaterThan(0)
  expect(passport.games.scratch.length).toBe(5) // The API shows the next five of ten issued cards.
  await page.goto('/explore/passport')
  await expect(page.getByRole('heading', { name: 'Your passport', exact: true })).toBeVisible()
  await expect(page.getByText('Points', { exact: true })).toBeVisible()
  await expect(page.getByText(/kg CO₂e kept out of the air/)).toBeVisible()
  await expect(page.getByRole('link', { name: /Lantern Chai Corner/ }).first()).toBeVisible()
  await page.screenshot({
    path: `output/playwright/tour-story/${info.project.name}-passport.png`,
    fullPage: true,
    animations: 'disabled',
  })
  await page.goto('/explore/s/demo-story-bengaluru-chai')
  await expect(
    page.getByRole('link', { name: 'Stamp card · 7 of 10 stamps', exact: true }),
  ).toBeVisible()
  await page.screenshot({
    path: `output/playwright/tour-story/${info.project.name}-customer-stamps.png`,
    fullPage: true,
    animations: 'disabled',
  })
  await page.goto('/explore/chats')
  await expect(page.getByText('Lantern Chai Corner (Demo)', { exact: true })).toBeVisible()
  await expect(page.getByText('Sunny Side Kopitiam (Demo)', { exact: true })).toBeVisible()
  const threads = await (await page.request.get('/api/v1/customer/threads')).json()
  const thread = threads.find((t: { shop: { id: string } }) => t.shop.id.includes('bengaluru'))
  await page.goto(`/explore/chats/${thread.shop.id}/${thread.thread.id}`)
  await expect(
    page.getByText("Yes, I'll keep two for you at the counter. See you at five!", { exact: true }),
  ).toBeVisible()
  await page.screenshot({
    path: `output/playwright/tour-story/${info.project.name}-chat.png`,
    fullPage: true,
    animations: 'disabled',
  })
  await page.goto('/explore/rescue')
  const deal = page.getByRole('listitem', { name: 'Sunny Side Kopitiam', exact: true })
  await expect(deal).toContainText('Kaya toast set')
  await expect(deal.getByRole('button', { name: 'Hold one for me' })).toBeVisible()
  await page.screenshot({
    path: `output/playwright/tour-story/${info.project.name}-rescue.png`,
    animations: 'disabled',
  })
})

test('owner tour connects Today, forecast, payment preview and supplier timeline', async ({
  page,
}, info) => {
  test.setTimeout(120_000)
  await enter(page)
  expect((await page.request.post('/api/v1/demo/workspace?zone=Asia/Kolkata')).ok()).toBeTruthy()
  await page.reload()
  await page.getByRole('button', { name: 'Continue local preview' }).click()
  await expect(page.getByRole('button', { name: /Choose shop: .*\(Tour\)/ })).toBeVisible()
  await page.getByRole('button', { name: /Choose shop:/ }).click()
  await page.getByRole('menuitem', { name: /Lantern Chai Corner/ }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.getByTestId('today-pulse')).toBeVisible()
  await expect(page.getByTestId('today-needs')).toBeVisible()
  await page.screenshot({
    path: `output/playwright/tour-story/${info.project.name}-owner-today.png`,
    animations: 'disabled',
  })
  await page.getByLabel('Message', { exact: true }).fill('Forecast my sales')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('figure', { name: /^Forecast chart:/ })).toBeVisible()
  await expect(page.getByText('Weekday average', { exact: true })).toBeVisible()
  await page.screenshot({
    path: `output/playwright/tour-story/${info.project.name}-owner-forecast.png`,
    fullPage: true,
    animations: 'disabled',
  })
  await page.getByRole('button', { name: 'Grow', exact: true }).click()
  await page.getByRole('button', { name: /^Payments & rides/ }).click()
  await page.getByRole('textbox', { name: 'Amount (INR)', exact: true }).fill('40')
  await page.getByRole('button', { name: 'Create link', exact: true }).click()
  await expect(page.getByRole('img', { name: /QR.*40/ })).toBeVisible()
  const payment = new URL(
    (await page.getByRole('link', { name: 'Open UPI', exact: true }).getAttribute('href'))!,
  )
  expect(payment.searchParams.get('pa')).toBe('chalkboard-demo@example.invalid')
  expect(payment.searchParams.get('am')).toBe('40.00')
  await page.screenshot({
    path: `output/playwright/tour-story/${info.project.name}-owner-payment.png`,
    fullPage: true,
    animations: 'disabled',
  })
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await page.getByRole('button', { name: 'Grow', exact: true }).click()
  await page.getByRole('button', { name: /Purchase orders/ }).click()
  await page.getByRole('button', { name: /PO 4500000001/ }).click()
  const order = page.getByRole('article', { name: 'PO 4500000001', exact: true })
  await expect(order).toBeVisible()
  await expect(order.getByText('Invoice in', { exact: true })).toBeVisible()
  await expect(order.getByText('Simulation', { exact: true })).toBeVisible()
  await page.screenshot({
    path: `output/playwright/tour-story/${info.project.name}-owner-supply.png`,
    animations: 'disabled',
  })
})

for (const language of [
  { locale: 'hi', profile: 'प्रोफ़ाइल और पसंद', load: 'डेमो कहानी खोलें' },
  { locale: 'zh-Hans', profile: '资料和偏好', load: '加载演示故事' },
]) {
  test(`demo action fits in ${language.locale}`, async ({ page }, info) => {
    await page.addInitScript((locale) => {
      localStorage.setItem('niva.starter.preferences', JSON.stringify({ language: locale }))
    }, language.locale)
    await page.request.post('/api/v1/customer/session', { data: { name: 'Demo judge' } })
    await page.goto('/explore/')
    await page.getByRole('button', { name: language.profile }).click()
    await expect(page.getByRole('button', { name: language.load })).toBeVisible()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    ).toBeTruthy()
    await page.screenshot({
      path: `output/playwright/tour-story/${info.project.name}-profile-${language.locale}.png`,
      animations: 'disabled',
    })
  })
}
