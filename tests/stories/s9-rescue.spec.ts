import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { closeSheet, enter, localOnly, phone, shareSigned, shot } from './support.js'

/**
 * A rescue needs a pickup time later today and no later than closing, whatever the wall clock
 * says when this runs. The shop therefore keeps its hours (06:00–23:00 every day) in a timezone
 * where it is currently daytime, so "until closing" is always a few hours away.
 */
function daytimeZone() {
  const zones = [
    'Asia/Kolkata',
    'Europe/London',
    'America/New_York',
    'America/Los_Angeles',
    'Asia/Tokyo',
    'Pacific/Auckland',
    'America/Sao_Paulo',
    'Asia/Dubai',
    'Pacific/Honolulu',
  ]
  const hour = (zone: string) =>
    Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(new Date()),
    )
  return zones.find((zone) => hour(zone) >= 8 && hour(zone) <= 19) ?? 'Asia/Kolkata'
}

const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

/** One shared shop at its own pin (see S8): area pin, exact point, then the menu. */
async function seedPinnedShop(page: Page, name: string, at: { lat: number; lng: number }) {
  const business = {
    name,
    category: 'Bakery',
    location: 'Jayanagar, Bengaluru',
    currency: 'INR',
    timezone: daytimeZone(),
    weekly_hours: days.map((day) => ({ day, open: '06:00', close: '23:00', closed: false })),
    locally_made: true,
    payment_methods: ['UPI', 'cash'],
    reward_text: 'Your tenth bun is free',
    stamps_needed: 10,
  }
  async function apply(data: object) {
    const prepared = await page.request.post('/api/v1/proposals', { data })
    expect(prepared.ok(), await prepared.text()).toBe(true)
    const proposal = await prepared.json()
    const approved = await page.request.post(`/api/v1/proposals/${proposal.id}/approve`, {
      data: { digest: proposal.digest },
    })
    expect(approved.ok(), await approved.text()).toBe(true)
    const { business_id: id } = await approved.json()
    const shops: { id: string; revision: number }[] = await (
      await page.request.get('/api/v1/businesses')
    ).json()
    return shops.find((shop) => shop.id === id)!
  }
  let shop = await apply({
    kind: 'business',
    revision: 0,
    geocode_confirmed: true,
    business,
    products: [],
  })
  shop = await apply({
    kind: 'business',
    business_id: shop.id,
    revision: shop.revision,
    business: { ...business, ...at },
    products: [],
  })
  await apply({
    kind: 'inventory',
    business_id: shop.id,
    revision: shop.revision,
    products: [
      { name: 'Masala bun', price: 2500, unit: 'piece', category: 'Bakes' },
      { name: 'Honey cake slice', price: 4000, unit: 'slice', category: 'Bakes' },
    ],
  })
  await page.reload()
  await page.getByRole('button', { name: 'Continue local preview' }).click()
  await expect(page.getByRole('button', { name: `Choose shop: ${name}` })).toBeVisible()
}

type Mode = 'light' | 'dark'

async function appearance(page: Page | import('@playwright/test').BrowserContext, mode: Mode) {
  await page.addInitScript((value) => {
    const key = 'niva.starter.preferences'
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ appearance: value }))
  }, mode)
}

/** Screenshot plus a WCAG 2 A/AA axe pass of whatever is on screen (dialogs included). */
function recorder(mode: Mode) {
  return async (page: Page, step: string | number) => {
    // GSAP fades are still running after a stamp arrives. Capture and audit the readable end state.
    await expect
      .poll(() =>
        page
          .locator('.stamp-line')
          .evaluateAll((lines) => lines.every((line) => getComputedStyle(line).opacity === '1')),
      )
      .toBe(true)
    await shot(page, 9, mode === 'light' ? step : `${step}-dark`)
    const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
    expect(
      violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
      `S9/${step} (${mode})`,
    ).toEqual([])
  }
}

async function ownerSends(page: Page, mode: Mode) {
  const evidence = recorder(mode)
  await test.step('1 · Grow: the morning brief, a quiet Rescue tile and Asked nearby', async () => {
    await page.getByRole('button', { name: 'Grow', exact: true }).click()
    const brief = page.getByRole('region', { name: 'Morning brief' })
    await expect(brief).toBeVisible()
    await expect(brief.getByRole('heading', { name: 'Prep today' })).toBeVisible()
    await expect(brief.getByRole('button', { name: /^Slide 1 of / })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Rescue/ })).toContainText('Leftovers?')
    await expect(page.getByRole('button', { name: /^Asked nearby/ })).toBeVisible()
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await evidence(page, '1-owner')
  })
  await test.step('2 · Rescue: pick what is left, 30% off, until closing', async () => {
    await page.getByRole('button', { name: /^Rescue/ }).click()
    const sheet = page.getByRole('dialog', { name: 'Closing-time rescue' })
    await expect(sheet).toBeVisible()
    // No sales history yet: no estimate, the owner chooses.
    await expect(
      sheet.getByText('No estimate yet: it needs sales history and closing hours.', {
        exact: false,
      }),
    ).toBeVisible()
    await sheet.getByLabel('Add an item').click()
    await page.getByRole('option', { name: 'Masala bun' }).click()
    await sheet.getByRole('button', { name: 'More Masala bun' }).click()
    await sheet.getByRole('button', { name: 'More Masala bun' }).click()
    await expect(sheet.getByRole('status', { name: 'Portions of Masala bun' })).toHaveText('6')
    await expect(sheet.getByRole('button', { name: '30% off' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(sheet.getByText('₹25.00 → ₹17.50')).toBeVisible()
    await expect(sheet.getByLabel('Pickup until')).toHaveValue('22:45')
    await evidence(page, '2-owner-rescue')
  })
  await test.step('3 · one tap sends it: live, with its countdown', async () => {
    const sheet = page.getByRole('dialog', { name: 'Closing-time rescue' })
    await sheet.getByRole('button', { name: 'Send rescue' }).click()
    const live = sheet.getByRole('region', { name: 'Live now' })
    await expect(live).toContainText('6 × Masala bun')
    await expect(live).toContainText('Held: 0 · Left: 6')
    await expect(live.getByRole('button', { name: 'End early' })).toBeVisible()
    await evidence(page, '3-owner-live')
    await closeSheet(page)
    await expect(page.getByRole('button', { name: /^Rescue/ })).toContainText('Live ·')
  })
}

async function customerHolds(customer: Page, shopName: string, qr: string, mode: Mode) {
  const evidence = recorder(mode)
  await localOnly(customer)
  await test.step('4 · the customer sees it on the Rescue map and list', async () => {
    await customer.goto(`http://127.0.0.1:${process.env.WEB_PORT ?? 3200}/explore/rescue`)
    await customer.getByRole('button', { name: 'Use my location' }).click()
    const rescueLead =
      /Leftovers from shops near|दुकानों का बचा हुआ खाना|দোকানের বেঁচে যাওয়া খাবার|దుకాಣాల్లో మిగిలిన ఆహారం|दुकानांतील उरलेले पदार्थ|ಅಂಗಡಿಗಳಲ್ಲಿ ಉಳಿದ ಆಹಾರ|கடைகளில் மீதமான உணவு|店铺打烊前剩下的食物|周辺のお店の|가게들이 문 닫기 전|อาหารเหลือจากร้าน|Lebihan makanan dari kedai|Sisa makanan dari toko|Đồ ăn còn dư|Mga natirang pagkain/
    await expect(customer.getByText(rescueLead)).toBeVisible()
    const card = customer.getByRole('listitem').filter({ hasText: shopName })
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(card).toContainText('Masala bun')
    await expect(card).toContainText('30% off')
    await expect(card).toContainText('Left: 6')
    await expect(card.getByRole('timer')).toContainText('Ends in')
    // Real deal, not a demo one: no demo label on it.
    await expect(card.getByText('Demo rescue')).toHaveCount(0)
    const pin = customer.getByRole('button', { name: new RegExp(`^${shopName}: Masala bun`) })
    await expect(pin).toBeVisible()
    await evidence(customer, '4-customer-map')
  })
  await test.step('5 · Hold one for me: sign in, then the exact chat message', async () => {
    const card = customer.getByRole('listitem').filter({ hasText: shopName })
    await card.getByRole('button', { name: 'Hold one for me' }).click()
    const signIn = customer.getByRole('dialog', { name: 'Sign in to hold a rescue' })
    await expect(signIn).toBeVisible()
    await signIn.getByRole('button', { name: /Continue with Google/ }).click()
    const hold = customer.getByRole('dialog', { name: 'Hold a rescue' })
    await expect(hold).toBeVisible()
    await expect(hold).toContainText('Hi! Could you hold 1 × Masala bun from your rescue')
    await expect(hold).toContainText('No payment here')
    await evidence(customer, '5-customer-hold')
  })
  await test.step('6 · held: the chat carries it, no payment', async () => {
    const hold = customer.getByRole('dialog', { name: 'Hold a rescue' })
    await hold.getByRole('button', { name: 'Send to the shop' }).click()
    const done = customer.getByRole('dialog', { name: 'Rescued!' })
    await expect(done).toContainText('Held until')
    await expect(done).toContainText('Show this chat at the counter.')
    await evidence(customer, '6-customer-held')
    await done.getByRole('button', { name: 'Open chat' }).click()
    await expect(customer).toHaveURL(/\/explore\/chats\//)
    await expect(customer.getByText('Hold request: 1 × Masala bun')).toBeVisible()
    await expect(customer.getByText(/Could you hold 1 × Masala bun/)).toBeVisible()
    await evidence(customer, '6-customer-chat')
  })
  await test.step('7 · the Rescue tab: held, one portion fewer', async () => {
    await customer.goto(`http://127.0.0.1:${process.env.WEB_PORT ?? 3200}/explore/rescue`)
    const holds = customer.getByRole('region', { name: 'Your holds' })
    await expect(holds).toContainText('1 × Masala bun')
    await expect(holds).toContainText('scan the shop’s QR code')
    const card = customer.getByRole('listitem').filter({ hasText: shopName })
    await expect(card).toContainText('Left: 5', { timeout: 20_000 })
    await expect(card.getByRole('button', { name: 'Held · Open chat' })).toBeVisible()
    await evidence(customer, '7-customer-holds')
  })
  await test.step('8 · collected at the counter: the QR gives a rescue stamp', async () => {
    await customer.goto(qr)
    const moment = customer.getByRole('dialog')
    await expect(moment.getByRole('button', { name: 'Done' })).toBeVisible()
    // Tap only once the check is done: a tap during it has no celebration to skip, and axe
    // would then read lines still fading in (as S8 does).
    await expect(moment.getByRole('progressbar')).toHaveCount(0)
    await moment.getByRole('heading').first().click()
    for (const line of await moment.locator('.stamp-line').all())
      await expect(line).toHaveCSS('opacity', '1', { timeout: 500 })
    await expect(moment.getByRole('heading', { name: 'Rescued!' })).toBeVisible()
    await expect(moment.getByText('Meals you kept out of the bin: 1')).toBeVisible()
    await expect(moment.getByText('+40 points')).toBeVisible()
    await evidence(customer, '8-customer-collected')
    await moment.getByRole('button', { name: 'Done' }).click()
  })
  await test.step('9 · impact: one meal rescued, money saved', async () => {
    await customer.goto(`http://127.0.0.1:${process.env.WEB_PORT ?? 3200}/explore/rescue`)
    const impact = customer.getByRole('region', { name: 'Your impact' })
    await expect(impact).toContainText('Meals rescued: 1')
    await expect(impact).toContainText('₹7.50')
    await expect(customer.getByRole('region', { name: 'Your holds' })).toHaveCount(0)
    await evidence(customer, '9-customer-impact')
  })
}

async function ownerSeesHold(page: Page, mode: Mode) {
  const evidence = recorder(mode)
  await test.step('10 · the owner sees the hold, in the tile and in Messages', async () => {
    await page.reload()
    await page.getByRole('button', { name: 'Continue local preview' }).click()
    await page.getByRole('button', { name: 'Grow', exact: true }).click()
    await expect(page.getByRole('button', { name: /^Rescue/ })).toContainText('Left: 5 of 6')
    await page.getByRole('button', { name: /^Rescue/ }).click()
    const sheet = page.getByRole('dialog', { name: 'Closing-time rescue' })
    await expect(sheet.getByRole('region', { name: 'Live now' })).toContainText('Held: 1 · Left: 5')
    await evidence(page, '10-owner-held')
  })
}

async function setup(page: Page, browser: Browser, mode: Mode) {
  await appearance(page, mode)
  await localOnly(page)
  await enter(page)
  const shopName = `Rescue Bakery ${Date.now().toString().slice(-5)}`
  // A pin of its own (see S8): no other test shop's rescue within the map's 3 km.
  const at = { lat: 13.0 + Math.random() * 0.4, lng: 77.9 + Math.random() * 0.4 }
  await seedPinnedShop(page, shopName, at)
  const { qr } = await shareSigned(page)
  await closeSheet(page)
  const context = await browser.newContext({
    ...phone,
    isMobile: true,
    hasTouch: true,
    colorScheme: mode === 'dark' ? 'light' : 'dark',
    permissions: ['geolocation'],
    geolocation: { latitude: at.lat, longitude: at.lng, accuracy: 15 },
  })
  await appearance(context, mode)
  return { context, shopName, qr }
}

test.use(phone)
test.skip(({ isMobile }) => !isMobile, 'Story evidence uses the phone project')
for (const mode of ['light', 'dark'] as const) {
  test(`S9 · the owner sends a rescue, a customer holds one and collects it (${mode})`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(180_000)
    const { context, shopName, qr } = await setup(page, browser, mode)
    try {
      await ownerSends(page, mode)
      const customer = await context.newPage()
      await customerHolds(customer, shopName, qr, mode)
      await ownerSeesHold(page, mode)
    } finally {
      await context.close()
    }
  })
}
