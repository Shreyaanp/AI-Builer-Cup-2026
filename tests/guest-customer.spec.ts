import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type APIRequestContext } from '@playwright/test'

async function seedShop(request: APIRequestContext) {
  await request.get('/api/v1/bootstrap')
  const me = await (await request.get('/api/v1/me')).json()
  expect(
    (
      await request.post('/api/v1/consent', {
        data: { version: me.legal_version, terms: true, privacy: true },
      })
    ).ok(),
  ).toBe(true)
  const business = {
    name: 'Guest Corner',
    location: 'Tiong Bahru, Singapore',
    hours: '07:00–20:00',
    stamps_enabled: true,
    stamps_needed: 3,
    reward_text: 'Free kopi',
  }
  async function apply(data: object) {
    const proposed = await request.post('/api/v1/proposals', { data })
    expect(proposed.ok()).toBe(true)
    const proposal = await proposed.json()
    const approved = await request.post(`/api/v1/proposals/${proposal.id}/approve`, {
      data: { digest: proposal.digest },
    })
    expect(approved.ok()).toBe(true)
    return (await approved.json()).business_id as string
  }
  const id = await apply({
    kind: 'business',
    business,
    products: [{ name: 'Kopi', price: 180, unit: 'cup' }],
  })
  const shops = await (await request.get('/api/v1/businesses')).json()
  await apply({
    kind: 'business',
    business_id: id,
    revision: shops.find((s: { id: string }) => s.id === id).revision,
    business: { ...business, lat: 1.285, lng: 103.827 },
    products: [],
  })
  expect(
    (
      await request.post(`/api/v1/businesses/${id}/share`, {
        data: { public: true },
      })
    ).ok(),
  ).toBe(true)
  const qr = await (await request.get(`/api/v1/businesses/${id}/qr-key`)).json()
  return { id, qr: qr.key as string }
}

test('guest on a 390 px phone: chat, follow, QR stamp, passport and claim gate', async ({
  page,
  request,
  context,
  browser,
  baseURL,
}, info) => {
  test.skip(info.project.name !== 'phone', 'Phone guest journey')
  test.setTimeout(120_000)
  const bootstrap = await (await request.get('/api/v1/bootstrap')).json()
  test.skip(!bootstrap.features.guest_customer, 'Run with GUEST_CUSTOMER=true')
  await page.route('**/*', (route) =>
    ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
      ? route.continue()
      : route.abort(),
  )
  await page.addInitScript(() => {
    localStorage.setItem('chalkboard.customer.journey', 'done')
    localStorage.setItem('niva.language.chosen', '1')
    localStorage.setItem(
      'niva.starter.preferences',
      JSON.stringify({ appearance: 'light', language: 'en' }),
    )
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await context.grantPermissions(['geolocation'])
  await context.setGeolocation({ latitude: 1.285, longitude: 103.827, accuracy: 10 })
  const { id, qr } = await seedShop(request)
  const shop = `/explore/s/${id}`
  const noGoogle = () =>
    expect(page.getByRole('button', { name: /Continue with Google/ })).toHaveCount(0)
  await page.goto(shop)
  await expect
    .poll(async () => (await (await page.request.get('/api/v1/customer/me')).json()).guest)
    .toBe(true)
  await page.getByRole('button', { name: 'Chat with the shop', exact: true }).click()
  await page.getByRole('button', { name: 'Ask the owner', exact: true }).last().click()
  await noGoogle()
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Can I visit this afternoon?')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/explore/chats/${id}/`))
  await expect(page.getByText('Can I visit this afternoon?', { exact: true })).toBeVisible()
  await noGoogle()
  // The owner can reply and close a guest conversation through the same inbox.
  const ownerContext = await browser.newContext({
    baseURL,
    storageState: await request.storageState(),
    viewport: { width: 390, height: 844 },
  })
  try {
    const owner = await ownerContext.newPage()
    await owner.route('**/*', (route) =>
      ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
        ? route.continue()
        : route.abort(),
    )
    await owner.addInitScript(() => {
      localStorage.setItem('niva.language.chosen', '1')
      localStorage.setItem('ogoogle.speakReplies', '0')
    })
    await owner.goto('/')
    await owner.getByRole('button', { name: 'Continue local preview' }).click()
    await owner.getByRole('button', { name: 'Shop', exact: true }).click()
    await owner.getByRole('button', { name: /^Messages 1/ }).click()
    const inbox = owner.getByRole('region', { name: /Messages/ })
    await expect(inbox).toContainText(/Guest [a-f0-9]{6}/)
    await expect(inbox).not.toContainText('@guest.invalid')
    await inbox.getByRole('button', { name: 'Open conversation', exact: true }).click()
    await inbox
      .getByRole('textbox', { name: 'Reply', exact: true })
      .fill('Yes, see you this afternoon!')
    await inbox.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(page.getByText('Yes, see you this afternoon!', { exact: true })).toBeVisible()
    await inbox.getByRole('button', { name: 'Block customer', exact: true }).click()
    await inbox
      .getByRole('group')
      .getByRole('button', { name: 'Block customer', exact: true })
      .click()
    await expect(page.getByText('This conversation is closed.', { exact: true })).toBeVisible()
    await inbox.getByRole('button', { name: 'Unblock customer', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled()
    await owner.screenshot({ path: 'output/playwright/guest-phone-owner-inbox.png' })
    expect(
      (
        await new AxeBuilder({ page: owner })
          .include('[aria-labelledby="messages-title"]')
          .withTags(['wcag2a', 'wcag2aa'])
          .analyze()
      ).violations,
    ).toEqual([])
  } finally {
    await ownerContext.close()
  }
  await page.goto(shop)
  await page.getByRole('button', { name: 'Follow Guest Corner', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Unfollow Guest Corner', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await noGoogle()
  const scan = page.waitForResponse(
    (r) => r.url().endsWith('/customer/passport/stamps') && r.request().method() === 'POST',
  )
  await page.goto(`${shop}?source=qr&k=${encodeURIComponent(qr)}`)
  const stamped = await (await scan).json()
  expect(stamped.outcome.verdict).toBe('stamped')
  await noGoogle()
  const reveal = page.getByRole('button', { name: /^Scratch card from Guest Corner/ })
  await expect(reveal).toBeVisible()
  await reveal.click()
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  const before = await (await page.request.get('/api/v1/customer/passport')).json()
  expect(before.stamps).toHaveLength(1)
  const repeat = await page.request.post('/api/v1/customer/passport/stamps', {
    data: { shop_id: id, key: qr },
  })
  expect((await repeat.json()).outcome.verdict).toBe('already_today')
  await page.goto('/explore/passport')
  await expect(page.getByRole('heading', { name: 'Your passport', exact: true })).toBeVisible()
  await noGoogle()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await expect(
    page.getByText('Sign in to keep freezes for your streak.', { exact: true }),
  ).toHaveCount(0)
  await page.getByRole('button', { name: 'Freeze next week', exact: true }).click()
  await noGoogle()
  await page.screenshot({ path: 'output/playwright/guest-phone-passport.png' })
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([])
  // A full card takes three shop-local days. Only the UI readiness response is substituted;
  // the journey above and backend sign-in gate use real local storage and HTTP routes.
  await page.route('**/api/v1/customer/passport?*', (route) => {
    const shops = before.shops.map((s: { id: string }) =>
      s.id === id ? { ...s, card: 3, stamps: 5 } : s,
    )
    return route.fulfill({ json: { ...before, shops } })
  })
  await page.goto(shop)
  await page.getByRole('button', { name: 'Claim reward', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Sign in to claim your reward')
  await expect(page.getByRole('button', { name: /Continue with Google/ })).toBeVisible()
  expect((await page.request.post(`/api/v1/customer/passport/shops/${id}/claim`)).status()).toBe(
    401,
  )
  await page.getByRole('button', { name: /Continue with Google/ }).click()
  await page.unroute('**/api/v1/customer/passport?*')
  await expect
    .poll(async () => (await (await page.request.get('/api/v1/customer/me')).json()).signed_in)
    .toBe(true)
  const after = await (await page.request.get('/api/v1/customer/passport')).json()
  expect(after.stamps).toEqual(before.stamps)
  const me = await (await page.request.get('/api/v1/customer/me')).json()
  expect(me.profile.follows).toContain(id)
  expect(
    (await (await page.request.get('/api/v1/customer/threads')).json())[0].thread.messages,
  ).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: 'Can I visit this afternoon?' })]),
  )
})
