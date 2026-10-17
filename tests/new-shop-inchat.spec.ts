import { AxeBuilder } from '@axe-core/playwright'
import { FIRST_QUESTION } from './newShopTopics.js'
import { expect, test, type Page } from '@playwright/test'
import { enter, inChatFixtures, localOnly } from './stories/support.js'

// The camera, the map and the step-by-step form inside the new-shop conversation (owner brief
// 16 Oct): light and dark, phone and desktop, axe on every state, and the failure paths.
test.use({ reducedMotion: 'reduce' })

async function audit(page: Page) {
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  )
}

async function open(page: Page, scheme: 'light' | 'dark') {
  await page.addInitScript((appearance) => {
    localStorage.setItem('niva.starter.preferences', JSON.stringify({ appearance }))
  }, scheme)
  await enter(page)
  await page.getByRole('banner').getByRole('button', { name: 'Add shop details' }).click()
  await page.getByRole('button', { name: 'Let’s begin' }).click()
  await expect(page.getByRole('log')).toContainText(FIRST_QUESTION)
}

const name = (state: string, scheme: string, isMobile: boolean) =>
  `docs/stories/new-shop-${state}-${scheme}${isMobile ? '' : '-desktop'}.png`

for (const scheme of ['light', 'dark'] as const) {
  test(`camera, map and the typed journey pass axe (${scheme})`, async ({
    page,
    context,
    isMobile,
  }) => {
    test.setTimeout(90_000)
    await localOnly(page)
    await inChatFixtures(page)
    // The camera is not allowed yet: the card explains why before the browser asks.
    await context.grantPermissions(['geolocation', 'microphone'])
    await context.setGeolocation({ latitude: 12.9718234, longitude: 77.6412345, accuracy: 20 })
    await open(page, scheme)

    await page.getByRole('button', { name: 'Shop photo' }).click()
    const camera = page.getByTestId('camera-card')
    await expect(camera).toHaveAttribute('data-phase', 'ask')
    await expect(camera).toContainText('Customers see this photo on your shop page')
    await audit(page)
    await page.screenshot({ path: name('camera-1-ask', scheme, isMobile) })
    await camera.getByRole('button', { name: 'Open camera' }).click()
    // The camera takes the whole screen; the card stays behind as the entry point.
    const modal = page.getByTestId('camera-modal')
    await expect(modal).toHaveAttribute('data-phase', 'live')
    // The camera opens next to the voice session: the mic controls keep working behind it.
    await expect(
      page.getByRole('button', { name: 'Pause the mic', includeHidden: true }),
    ).toHaveAttribute('aria-pressed', 'false')
    await audit(page)
    await page.screenshot({ path: name('camera-2-viewfinder', scheme, isMobile) })
    await modal.getByRole('button', { name: 'Close camera' }).click()
    await expect(modal).toHaveCount(0)
    await expect(camera).toHaveAttribute('data-phase', 'ask')
    await camera.getByRole('button', { name: 'Close camera' }).click()
    await expect(camera).toHaveCount(0)

    // "My location" saves the phone's location at once (owner decision, 17 Oct): the browser's
    // own prompt only, no confirm step in the app.
    let sent: { source?: string; accuracy_m?: number } | undefined
    page.on('request', (request) => {
      if (request.url().endsWith('/api/v1/proposals') && request.method() === 'POST')
        sent = request.postDataJSON().owner_location
    })
    await page.getByRole('button', { name: 'My location' }).click()
    const map = page.getByTestId('map-card')
    await expect(map).toHaveAttribute('data-state', 'done')
    await expect(map).toContainText('Near Indiranagar')
    expect(sent).toMatchObject({ source: 'device', accuracy_m: 20 })
    await expect(page.getByRole('button', { name: 'This is my shop' })).toHaveCount(0)
    await audit(page)
    await page.screenshot({ path: name('map-1-small', scheme, isMobile) })

    await page.getByRole('button', { name: 'Type it in instead' }).click()
    await expect(page.getByTestId('guided-details')).toHaveAttribute('data-step', 'name')
    await audit(page)
    await page.screenshot({ path: name('manual-1-name', scheme, isMobile) })
    await page.getByRole('button', { name: 'Items' }).click()
    await audit(page)
    await page.screenshot({ path: name('manual-3-items', scheme, isMobile) })
    // Back returns to the same conversation.
    await page.goBack()
    await expect(page.getByRole('log')).toContainText(FIRST_QUESTION)
  })
}

test('camera blocked: the alert explains, Try again and Upload instead work', async ({ page }) => {
  await localOnly(page)
  await inChatFixtures(page, 'denied')
  await open(page, 'light')
  await page.getByRole('button', { name: 'Shop photo' }).click()
  const camera = page.getByTestId('camera-card')
  await camera.getByRole('button', { name: 'Open camera' }).click()
  const alert = page.getByTestId('camera-alert')
  await expect(alert).toHaveAttribute('data-problem', 'blocked')
  await expect(alert).toContainText('Camera → Allow')
  await audit(page)
  await alert.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByTestId('camera-alert')).toBeVisible()
  // The conversation is untouched and the voice controls are still there.
  await expect(page.getByRole('log')).toContainText(FIRST_QUESTION)
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('camera-alert').getByRole('button', { name: 'Upload instead' }).click()
  await chooser
  await page.getByTestId('camera-alert').getByRole('button', { name: 'Close' }).click()
  await expect(camera).toHaveCount(0)
})

// Location refused: the card stays open so the owner can place the pin by hand (and confirm it).
async function refuseLocation(page: Page) {
  await page.addInitScript(() => {
    navigator.geolocation.getCurrentPosition = (_, fail) =>
      fail?.({ code: 1, message: 'denied' } as GeolocationPositionError)
  })
}

test('a pin moved by hand is saved as the owner’s pin, not as GPS accuracy', async ({
  page,
  context,
}) => {
  await localOnly(page)
  await inChatFixtures(page)
  await refuseLocation(page)
  await context.grantPermissions(['microphone'])
  await open(page, 'light')
  await page.getByRole('button', { name: 'My location' }).click()
  const map = page.getByTestId('map-card')
  await expect(map).toHaveAttribute('data-state', 'open')
  await map.getByRole('button', { name: 'Bigger map' }).click()
  const big = page.getByRole('dialog', { name: 'Where is your shop?' })
  await expect(big.getByTestId('pin-map')).toBeVisible()
  await audit(page)
  await big.getByRole('button', { name: 'Close the big map' }).click()
  await expect(big).toBeHidden()
  const surface = map.getByTestId('pin-map')
  const before = Number(await surface.getAttribute('data-lng'))
  // Drag the map by touch-free pointer moves, then nudge with the keyboard; both send the pin
  // west (dragging right shows what lies west, as ArrowLeft does), so they add up.
  const box = (await surface.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 6 })
  await page.mouse.up()
  await surface.focus()
  await page.keyboard.press('ArrowLeft')
  expect(Number(await surface.getAttribute('data-lng'))).toBeLessThan(before - 0.001)
  await expect(map).toContainText('Move the map so the pin sits on your shop’s door.')
  let sent: { source?: string } | undefined
  page.on('request', (request) => {
    if (request.url().endsWith('/api/v1/proposals') && request.method() === 'POST')
      sent = request.postDataJSON().owner_location
  })
  await map.getByRole('button', { name: 'This is my shop' }).click()
  // Saved silently: the card shows the pin (no action card in the chat).
  await expect(map).toHaveAttribute('data-state', 'done')
  expect(sent?.source).toBe('pin')
})

test('map pictures offline: the chalk grid stays and the pin still works', async ({
  page,
  context,
}) => {
  await localOnly(page)
  await inChatFixtures(page)
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
  await refuseLocation(page)
  await context.grantPermissions(['microphone'])
  await open(page, 'light')
  await page.getByRole('button', { name: 'My location' }).click()
  const map = page.getByTestId('map-card')
  await expect(map).toContainText('The map pictures are not available right now')
  await map.getByRole('button', { name: 'This is my shop' }).click()
  await expect(map).toHaveAttribute('data-state', 'done')
})

for (const scheme of ['light', 'dark'] as const) {
  test(`at 360x800 in-chat map and confirm button are visible without scrolling (${scheme})`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 })
    await localOnly(page)
    await inChatFixtures(page)
    await refuseLocation(page)
    await context.grantPermissions(['microphone'])
    await open(page, scheme)
    await page.getByRole('button', { name: 'My location' }).click()
    const confirmBtn = page.getByRole('button', { name: 'This is my shop' })
    await expect(confirmBtn).toBeVisible()
    const box = (await confirmBtn.boundingBox())!
    // Full 48px touch target, completely visible within the 800px viewport without scrolling
    expect(box.height).toBeGreaterThanOrEqual(48)
    expect(box.y + box.height).toBeLessThanOrEqual(800)
    const logScroll = await page
      .getByRole('region', { name: 'Conversation' })
      .evaluate((el) => el.scrollTop)
    expect(logScroll).toBe(0)
  })
}
