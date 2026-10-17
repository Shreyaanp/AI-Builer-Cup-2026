import { mkdir } from 'node:fs/promises'
import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { enter, image, localOnly } from './stories/support.js'

// The Coach tab's first view ("Today"): day one, items that need the owner, all set, and the
// pill it shrinks to while chatting. Server facts are the real endpoint unless a test needs
// numbers a fresh database cannot have yet (sales history, page opens), which are routed.

const FULL = {
  category: 'Cafe',
  location: 'Indiranagar, Bengaluru',
  currency: 'INR',
  timezone: 'Asia/Kolkata',
  hours: '07:00–20:00',
  phone: '+91 80 4000 1234',
  halal: 'no',
  vegetarian_options: true,
  locally_made: true,
  preorders: false,
  payment_methods: ['UPI', 'cash'],
  delivery: 'none',
  busy_hours: '5pm-7pm',
}
const PRODUCTS = [
  { name: 'Masala chai', price: 2000, unit: 'cup', category: 'Drinks', stock: 40 },
  { name: 'Bun maska', price: 3000, unit: 'plate', category: 'Snacks' },
]

async function axe(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all(
      document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
    )
  })
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze()
  expect(result.violations.map((v) => [v.id, v.nodes.map((n) => [n.target, n.html])])).toEqual([])
}

async function shot(page: Page, name: string) {
  await mkdir('docs/stories', { recursive: true })
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all(
      document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
    )
  })
  const project = test.info().project.name
  await page.screenshot({ path: `docs/stories/today-${name}-${project}.png` })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  )
}

/** A saved shop straight through the API (the new-shop flow has its own tests). */
async function shop(
  page: Page,
  fields: Record<string, unknown>,
  products: Record<string, unknown>[],
  options: { share?: boolean; confirm?: boolean; complete?: boolean } = {},
) {
  if (options.complete)
    // The owner's face check is done (onboarding offers it; skipped, Today reminds).
    await page.route('**/api/v1/trust', async (route) => {
      const response = await route.fetch()
      await route.fulfill({ response, json: { ...(await response.json()), face: 'verified' } })
    })
  const prepared = await page.request.post('/api/v1/proposals', {
    data: { kind: 'business', revision: 0, business: fields, products },
  })
  expect(prepared.ok()).toBe(true)
  const proposal = await prepared.json()
  const approved = await page.request.post(`/api/v1/proposals/${proposal.id}/approve`, {
    data: { digest: proposal.digest },
  })
  expect(approved.ok()).toBe(true)
  const { business_id: id } = await approved.json()
  if (options.share)
    expect(
      (await page.request.post(`/api/v1/businesses/${id}/share`, { data: { public: true } })).ok(),
    ).toBe(true)
  if (options.confirm)
    expect((await page.request.post(`/api/v1/businesses/${id}/freshness/confirm`)).ok()).toBe(true)
  if (options.complete)
    // The shop photo (onboarding asks for it; skipped, Today reminds).
    expect(
      (
        await page.request.post(`/api/v1/businesses/${id}/gallery`, {
          headers: { 'content-type': 'image/png' },
          data: (await image(page)).buffer,
        })
      ).ok(),
    ).toBe(true)
  await page.reload()
  await page.getByRole('button', { name: 'Continue local preview' }).click()
  await expect(page.getByRole('button', { name: `Choose shop: ${fields.name}` })).toBeVisible()
  return id as string
}

/** Routes the Today facts with numbers merged over the real response. */
async function facts(page: Page, extra: Record<string, unknown>) {
  await page.route('**/api/v1/businesses/*/today', async (route) => {
    const response = await route.fetch()
    const json = { ...(await response.json()), ...extra }
    await route.fulfill({ response, json })
  })
}

const greeting = /^Good (morning|afternoon|evening)/

test.beforeEach(async ({ page }) => {
  test.setTimeout(60_000)
  // Midday in the shop's zone, so the evening close-the-day need never depends on when CI runs.
  await page.clock.setFixedTime(new Date('2026-10-17T11:00:00+08:00'))
  await localOnly(page)
  // "Close the day" joins Today in the evening; pin the browser to 10:00 in Kolkata so these
  // tests see the same Today whatever the runner's clock says.
  await page.clock.setFixedTime(new Date('2026-10-17T04:30:00Z'))
  await enter(page)
})
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('day one: setup bar, a warm start with the next step and the mic, no empty numbers', async ({
  page,
}) => {
  await shop(page, { name: 'Courtyard Chai', category: 'Tea stall', currency: 'INR' }, [])
  const today = page.getByTestId('today')
  await expect(today.getByRole('heading', { level: 1, name: greeting })).toBeVisible()
  await expect(page.getByTestId('today-progress')).toContainText('2/6')
  const start = page.getByTestId('today-day-one')
  await expect(
    start.getByRole('heading', { name: 'Let’s get Courtyard Chai online' }),
  ).toBeVisible()
  await expect(start).toContainText('Add your menu')
  await expect(start.getByRole('button', { name: 'Scan' })).toBeVisible()
  await expect(start.getByRole('button', { name: 'Talk to me' })).toBeVisible()
  // Nothing measured yet: no pulse, and the first step is not repeated in the card.
  await expect(page.getByTestId('today-pulse')).toHaveCount(0)
  await expect(page.locator('[data-need="step"]')).toHaveCount(0)
  // Day one has nothing to call "all set", and only one filled button.
  await expect(page.getByTestId('today-all-set')).toHaveCount(0)
  await expect(today.locator('.MuiButton-contained')).toHaveCount(1)
  // The old stacked blocks are gone.
  await expect(today.getByRole('button', { name: /^Shop details/ })).toHaveCount(0)
  await expect(page.getByTestId('coach-attention')).toHaveCount(0)
  await axe(page)
  await shot(page, 'day-one')
})

test('Today stays available when server facts omit today metrics', async ({ page }) => {
  await facts(page, { today: undefined })
  await shop(page, { name: 'Courtyard Chai', ...FULL }, PRODUCTS)

  await expect(page.getByTestId('today')).toBeVisible()
  await expect(page.getByTestId('today-pulse')).toHaveCount(0)
})

test('needs you now: at most three, most urgent first, each leaves when done', async ({ page }) => {
  await facts(page, {
    yesterday: { sales: 420000, items: 210, views: 38, questions: 3, stamps: 9, returning: 4 },
    forecast: { item: 'Masala chai', quantity: 45, unit: 'cup' },
    low_stock: [{ name: 'Masala chai', stock: 4, runs_out: null }],
    line: { kind: 'festival', festival: 'diwali', days: 3 },
  })
  await shop(page, { name: 'Courtyard Chai', ...FULL, phone: '' }, PRODUCTS)
  await expect(page.getByTestId('today-line')).toHaveText('Diwali in 3 days: plan your stock')
  const card = page.getByTestId('today-needs')
  await expect(card.getByRole('heading', { name: 'Needs you now' })).toBeVisible()
  const rows = card.getByRole('listitem')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText('Still the same menu today?')
  await expect(rows.nth(1)).toContainText('Masala chai: only 4 left')
  await expect(rows.nth(2)).toContainText('Add a phone number')
  // One primary action: only the top row's button is filled.
  await expect(card.locator('.MuiButton-contained')).toHaveCount(1)
  const pulse = page.getByTestId('today-pulse')
  await expect(pulse).toContainText('Yesterday: ₹4,200 · 38 saw your page · 3 asked')
  await expect(pulse).toContainText('Today: about 45 Masala chai, busiest')
  await expect(page.getByTestId('today-progress')).toContainText('5/6')
  await axe(page)
  await shot(page, 'needs')
  // Answer the daily question: the row leaves and the next item takes its place.
  await rows.nth(0).getByRole('button', { name: 'Yes' }).click()
  await expect(card).not.toContainText('Still the same menu today?')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(2)).toContainText('Share your page')
})

test('all set: nothing pending means no card, one calm line and the pulse', async ({ page }) => {
  await facts(page, {
    yesterday: { sales: 615000, items: 300, views: 52, questions: 4 },
    forecast: { item: 'Masala chai', quantity: 60, unit: 'cup' },
  })
  await shop(page, { name: 'Courtyard Chai', ...FULL }, PRODUCTS, {
    share: true,
    confirm: true,
    complete: true,
  })
  await expect(page.getByTestId('today-all-set')).toHaveText('All set for today')
  await expect(page.getByTestId('today-needs')).toHaveCount(0)
  await expect(page.getByTestId('today-progress')).toHaveCount(0)
  await expect(page.getByTestId('today-pulse')).toBeVisible()
  await axe(page)
  await shot(page, 'all-set')
  // Tapping the pulse asks the coach how yesterday went.
  await page.getByTestId('today-pulse').click()
  await expect(page.getByRole('log')).toContainText('How did yesterday go?')
  await expect(page.getByTestId('today')).toHaveCount(0)
  // Nothing needs the owner, so no pill either.
  await expect(page.getByTestId('today-pill')).toHaveCount(0)
})

test('while chatting the card shrinks to one pill that opens the same items', async ({ page }) => {
  await facts(page, { yesterday: { sales: 420000, views: 38 } })
  await shop(page, { name: 'Courtyard Chai', ...FULL, phone: '' }, PRODUCTS, { complete: true })
  await expect(page.getByTestId('today-needs').getByRole('listitem')).toHaveCount(3)
  await page.getByLabel('Message', { exact: true }).fill('Hello')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('log')).toContainText('Hello')
  await expect(page.getByTestId('today')).toHaveCount(0)
  const pill = page.locator('[aria-controls="today-pill-panel"]')
  await expect(pill).toHaveText('3 things need you')
  await expect(pill).toHaveAttribute('aria-expanded', 'false')
  await pill.click()
  await expect(pill).toHaveAttribute('aria-expanded', 'true')
  await expect(pill).toHaveText('Hide')
  const items = page.getByTestId('today-pill').getByRole('listitem')
  await expect(items).toHaveCount(3)
  await axe(page)
  await shot(page, 'chatting')
  // Done from the pill: the item leaves and the count follows.
  await items.first().getByRole('button', { name: 'Yes' }).click()
  await expect(items.first()).not.toContainText('Still the same menu today?')
  await expect(items).toHaveCount(2)
  await pill.click()
  await expect(pill).toHaveText('2 things need you')
})

for (const [language, heading, resume] of [
  ['hi', 'चलिए Courtyard Chai को ऑनलाइन लाएँ', 'स्थानीय प्रीव्यू जारी रखें'],
  ['ja', 'Courtyard Chaiをオンラインにしましょう', 'ローカルプレビューを続ける'],
] as const)
  test(`speaks the owner's language (${language}), dark`, async ({ page }) => {
    await shop(page, { name: 'Courtyard Chai', category: 'Tea stall', currency: 'INR' }, [])
    await page.evaluate(
      (lang) =>
        localStorage.setItem(
          'niva.starter.preferences',
          JSON.stringify({ appearance: 'dark', language: lang }),
        ),
      language,
    )
    await page.reload()
    await page.getByRole('button', { name: resume }).click()
    await expect(page.getByRole('heading', { name: heading })).toBeVisible()
    await axe(page)
    await shot(page, `${language}-dark`)
  })

test('GAP 8: Close the day appears in evening needs you now and opens modal, Grow tile intact', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.clock.setFixedTime(new Date('2026-10-17T19:30:00+05:30'))
  await facts(page, {
    yesterday: { sales: 420000, items: 210, views: 38 },
  })
  await shop(page, { name: 'Courtyard Chai', ...FULL }, PRODUCTS, { confirm: true })

  const card = page.getByTestId('today-needs')
  await expect(card.getByRole('heading', { name: 'Needs you now' })).toBeVisible()
  const closeRow = card.locator('[data-need="closeDay"]')
  await expect(closeRow).toBeVisible()
  await expect(closeRow).toContainText('Ready to close today?')

  const closeButton = closeRow.getByRole('button', { name: 'Close the day' })
  await expect(closeButton).toBeVisible()

  const box = await closeButton.boundingBox()
  expect(box).toBeTruthy()
  expect(Math.round(box!.height)).toBeGreaterThanOrEqual(48)

  await closeButton.click()
  const dialog = page.getByRole('dialog', { name: 'Close the day' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Till or POS report')).toBeVisible()

  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toHaveCount(0)

  // 3. Grow tab still has Close the day tile intact and functional
  await page.getByRole('button', { name: 'Grow', exact: true }).click()
  const growTile = page.locator('[data-tour="closeday"]')
  await expect(growTile).toBeVisible()
  await expect(growTile).toContainText('Close the day')
  await growTile.click()
  await expect(page.getByRole('dialog', { name: 'Close the day' })).toBeVisible()
})

test('shows skeleton while products load; never shows done "Add your menu" step for shop with menu', async ({
  page,
}) => {
  await shop(page, { name: 'Courtyard Chai', ...FULL }, PRODUCTS, { share: true })
  let releaseInventory: () => void = () => {}
  const inventoryHeld = new Promise<void>((resolve) => {
    releaseInventory = resolve
  })
  await page.route('**/api/v1/businesses/*/inventory', async (route) => {
    await inventoryHeld
    await route.continue()
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Continue local preview' }).click()

  // While inventory is loading: skeleton is visible, and "Add your menu" is NEVER shown.
  await expect(page.getByTestId('today-skeleton')).toBeVisible()
  await expect(page.getByTestId('today-day-one')).toHaveCount(0)
  await expect(page.getByText('Add your menu')).toHaveCount(0)

  // Now release inventory.
  releaseInventory()
  await expect(page.getByTestId('today-skeleton')).toHaveCount(0)
  await expect(page.getByTestId('today')).toBeVisible()
  await expect(page.getByTestId('today-day-one')).toHaveCount(0)
  await expect(page.getByText('Add your menu')).toHaveCount(0)
})
