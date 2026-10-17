import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { FIRST_QUESTION } from './newShopTopics.js'
import {
  confirm,
  createShopFromReview,
  enter,
  image,
  localOnly,
  openNewShopReview,
  seedShop,
} from './stories/support.js'

/// The full-screen new-shop flow (onboarding v2): hero, a coach-led conversation that fills the
// shop card silently, the shop live by itself after name + kind + place, "Review my shop" as a
// sheet at any moment, then the ready moment.
test.use({ reducedMotion: 'reduce' })
test.beforeEach(async ({ page }) => {
  await localOnly(page)
})

/** `sheet`: the flow's one sheet, "Review my shop", is open. */
async function audit(page: Page, sheet = false) {
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  )
  // Nothing else in the flow is a modal, dialog or sheet.
  await expect(page.getByRole('dialog')).toHaveCount(sheet ? 1 : 0)
}

async function begin(page: Page) {
  await page.getByRole('banner').getByRole('button', { name: 'Add shop details' }).click()
  await page.getByRole('button', { name: 'Let’s begin' }).click()
  await expect(page.getByRole('log')).toContainText(FIRST_QUESTION)
}

async function say(page: Page, text: string) {
  await page.getByLabel('Message', { exact: true }).fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

const shops = async (page: Page) => (await page.request.get('/api/v1/businesses')).json()

for (const scheme of ['light', 'dark'] as const) {
  // Screenshots of every state (voice mode included) come from tests/new-shop-voice.spec.ts.
  test(`hero, conversation, review and ready pass axe (${scheme})`, async ({ page }) => {
    await page.addInitScript((appearance) => {
      localStorage.setItem('niva.starter.preferences', JSON.stringify({ appearance }))
    }, scheme)
    await enter(page)
    const capture = (step: string, sheet = false) =>
      test.step(`audit ${step}`, () => audit(page, sheet))
    await page.getByRole('banner').getByRole('button', { name: 'Add shop details' }).click()
    await expect(page).toHaveURL(/\/new-shop\?step=hero/)
    await expect(page.getByRole('heading', { name: 'Let’s open your shop' })).toBeFocused()
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0)
    await capture('1-hero')
    await page.getByRole('button', { name: 'Let’s begin' }).click()
    await expect(page.getByRole('log')).toContainText(FIRST_QUESTION)
    await say(page, 'name: Market Chai; category: Tea stall')
    await expect(page.getByTestId('shop-so-far')).toContainText('Market Chai')
    await expect(page.getByRole('log')).toContainText('Are you at the shop right now?')
    await capture('2-chat')
    await page.getByRole('button', { name: 'Review my shop' }).click()
    await expect(page.getByTestId('draft-summary')).toContainText('Market Chai')
    await capture('3-review', true)
    await page.keyboard.press('Escape')
    await say(page, 'location: Indiranagar')
    await expect(page.getByTestId('shop-live')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Your shop is ready' })).toBeFocused()
    await capture('4-ready')
    await page.getByRole('button', { name: 'Continue with my shop' }).click()
    await expect(page.getByRole('button', { name: 'Choose shop: Market Chai' })).toBeVisible()
  })
}

test('a shop photo in the chat: the card shows it, no menu is read, the gallery is offered', async ({
  page,
}) => {
  await enter(page)
  await page.route('**/api/v1/photos?*', (route) =>
    route.fulfill({
      json: {
        status: 'nothing_to_propose',
        photo_kind: 'menu',
        proposal: null,
        extraction: {
          uncertain: ['Offline fixture: no model read this photo.'],
          business: { name: '', category: '', location: '', hours: '', phone: '' },
          products: [{ name: 'Chai', price: 15, unit: 'cup', category: 'Drinks' }],
        },
      },
    }),
  )
  await begin(page)
  // The camera card opens in the chat; a photo the owner already has goes in by upload.
  await page.getByRole('button', { name: 'Shop photo' }).click()
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('camera-card').getByRole('button', { name: 'Upload instead' }).click()
  await (await chooser).setFiles(await image(page))
  const card = page.getByTestId('shop-so-far')
  await expect(card).toContainText('Photo added')
  // Onboarding never takes a menu: the items wait for "Add your menu" on Today.
  await expect(card).not.toContainText('Chai')
  // A photo is not evidence of a name: the owner supplies it.
  await expect(page.getByRole('log')).toContainText(FIRST_QUESTION)
  await say(page, 'name: Chai Corner; category: Tea stall; location: Indiranagar')
  await expect(page.getByTestId('shop-live')).toBeVisible()
  await createShopFromReview(page)
  // Gallery reuse stays an offer, never automatic.
  await expect(page.getByText('Add this photo to your shop gallery?')).toBeVisible()
})

test('a measured location pins the shop; with name and kind it goes live with the pin', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['geolocation'])
  await context.setGeolocation({ latitude: 12.9718234, longitude: 77.6412345, accuracy: 20 })
  await enter(page)
  await begin(page)
  await say(page, 'name: Courtyard Chai; category: Tea stall')
  await expect(page.getByTestId('shop-so-far')).toContainText('Courtyard Chai')
  // "Are you at the shop right now?" opens the map; the measured point is saved at once (owner
  // decision, 17 Oct: only the browser's prompt, no confirm step).
  const map = page.getByTestId('map-card')
  await map.getByRole('button', { name: 'Use my current location' }).click()
  await expect(map).toHaveAttribute('data-state', 'done')
  await expect(map).toContainText('Near Indiranagar')
  await expect(page.getByTestId('shop-so-far')).toContainText('Near Indiranagar')
  await expect(page.getByTestId('shop-live')).toBeVisible()
  await expect
    .poll(async () => (await shops(page))[0]?.fields)
    .toMatchObject({ lat: 12.9718234, lng: 77.6412345, pin_source: 'device' })
  await createShopFromReview(page)
  expect(await shops(page)).toHaveLength(1)
})

test('denied location: the coach says so in the chat; an address still works', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.geolocation.getCurrentPosition = (_success, failure) =>
      failure?.({ code: 1 } as GeolocationPositionError)
  })
  await enter(page)
  await begin(page)
  await page.getByRole('button', { name: 'My location' }).click()
  await expect(page.getByRole('log')).toContainText('Location access was denied')
  await say(page, 'name: Corner Bakery; location: Katong; category: Bakery')
  await expect(page.getByTestId('shop-so-far')).toContainText('Katong')
  await expect(page.getByTestId('shop-live')).toBeVisible()
  await page.getByRole('button', { name: 'Review my shop' }).click()
  await expect(page.getByTestId('draft-summary')).toContainText('Katong')
  await createShopFromReview(page)
  await expect(page.getByRole('button', { name: 'Choose shop: Corner Bakery' })).toBeVisible()
})

test('closing the review returns to the same conversation, which carries on', async ({ page }) => {
  await enter(page)
  await openNewShopReview(page, 'name: First Bakery; category: Bakery')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('draft-summary')).toHaveCount(0)
  await expect(page.getByRole('log')).toContainText('Are you at the shop right now?')
  await say(page, 'name: Revised Bakery')
  await expect(page.getByTestId('shop-so-far')).toContainText('Revised Bakery')
  await page.getByRole('button', { name: 'Review my shop' }).click()
  await expect(page.getByTestId('draft-summary')).toContainText('Revised Bakery')
  await createShopFromReview(page)
  await expect(page.getByRole('button', { name: 'Choose shop: Revised Bakery' })).toBeVisible()
})

test('header plus opens a separate draft; cancel restores the current shop draft', async ({
  page,
}) => {
  await enter(page)
  await seedShop(page)
  const before = await shops(page)
  await page.getByLabel('Message', { exact: true }).fill('Keep my daily draft')
  await page.getByRole('button', { name: 'Add shop details', exact: true }).click()
  await expect(page).toHaveURL(/\/new-shop/)
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep my daily draft')
  await page.getByRole('button', { name: /Choose shop/ }).click()
  await page.getByRole('menuitem', { name: 'New shop', exact: true }).click()
  await page.getByRole('button', { name: 'Let’s begin' }).click()
  await expect(page.getByRole('log')).toContainText(FIRST_QUESTION)
  await say(page, 'name: Second Bakery; category: Bakery')
  await expect(page.getByTestId('shop-so-far')).toContainText('Second Bakery')
  // Without a place the new shop is not live yet: nothing is saved.
  expect(await shops(page)).toEqual(before)
  await createShopFromReview(page)
  await expect(page.getByRole('button', { name: 'Choose shop: Second Bakery' })).toBeVisible()
  expect(await shops(page)).toHaveLength(2)
})

test('shop details proposes a measured location without silently saving', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['geolocation'])
  await context.setGeolocation({ latitude: -6.2088, longitude: 106.8456, accuracy: 35 })
  await enter(page)
  await seedShop(page)
  const before = await (await page.request.get('/api/v1/businesses')).json()
  await page.getByRole('button', { name: 'Shop', exact: true }).click()
  await page.getByRole('button', { name: /^Shop details/ }).click()
  await page.getByRole('button', { name: 'Use my current location' }).click()
  const review = page.getByRole('dialog', { name: 'Check before saving' })
  await expect(review).toContainText('within 35 m')
  await expect(review).toContainText('Near Jakarta')
  expect(await (await page.request.get('/api/v1/businesses')).json()).toEqual(before)
  await confirm(page)
})
