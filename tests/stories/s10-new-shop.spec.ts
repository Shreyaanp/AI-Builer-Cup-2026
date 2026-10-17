import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { FIRST_QUESTION, FOLLOW_UPS, nextQuestion } from '../newShopTopics.js'
import { enter, inChatFixtures, liveOnly, localOnly, phone, shot } from './support.js'

// S10 · Opening a new shop (owner answers, 15–17 Oct): big hero, then a full-screen conversation
// in which the coach speaks first with one open question, asks only the basics still missing,
// then at most two follow-ups that fit the shop (#112) and a shop photo (no menu), fills the shop
// card silently, opens the map and the camera as cards inside the chat,
// puts the shop live once name + kind + place are known, and ends in one summary card (the face
// check optional), a ready moment and the Google Maps hand-off.
test.use(phone)
// Light and dark captures of every screen (phone and desktop) are in tests/new-shop.spec.ts,
// tests/new-shop-voice.spec.ts and tests/new-shop-inchat.spec.ts.
test.skip(({ isMobile }) => !isMobile, 'Story evidence uses the phone project')

async function axe(page: Page, dialogs = 0) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    )
  })
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([])
  await expect(page.getByRole('dialog')).toHaveCount(dialogs)
}

/** Evidence for the in-chat cards: docs/stories/new-shop-{name}.png */
async function evidence(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: `docs/stories/new-shop-${name}.png`, animations: 'disabled' })
}

test('S10 · owner opens a new shop by talking to the coach', async ({ page, context }) => {
  test.setTimeout(150_000)
  await localOnly(page)
  // A local tone stands in for the microphone (the offline backend runs no speech recognition),
  // a canvas price board for the camera, and local tiles for the map.
  await inChatFixtures(page)
  await context.grantPermissions(['geolocation', 'microphone', 'camera'])
  await context.setGeolocation({ latitude: 12.9718234, longitude: 77.6412345, accuracy: 20 })
  await enter(page)

  await test.step('1 · "+" opens the hero (no dialog)', async () => {
    await page.getByRole('banner').getByRole('button', { name: 'Add shop details' }).click()
    await expect(page.getByRole('heading', { name: 'Let’s open your shop' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0)
    // Let the chalk drawing finish before the evidence shot.
    await page.waitForTimeout(3000)
    await axe(page)
    await shot(page, 10, '1-hero')
  })

  await test.step('2 · the coach greets first, out loud, and the mic opens', async () => {
    liveOnly(
      'Gemini Live voice and its spoken greeting; offline the greeting is the scripted coach',
    )
    await page.getByRole('button', { name: 'Let’s begin' }).click()
    await expect(page.getByRole('log')).toContainText(FIRST_QUESTION)
    // Voice mode: one open conversation; the mic stays on (not paused) after the greeting and
    // the orb listens. Keyboard, mute and end voice are the other controls.
    await expect(page.getByTestId('voice-orb').first()).toHaveAttribute('data-phase', 'listening')
    await expect(page.getByRole('button', { name: 'Pause the mic' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    await expect(page.getByRole('button', { name: 'Mute the coach’s voice' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'End voice' })).toBeVisible()
    await shot(page, 10, '2-greeting')
  })

  await test.step('3 · the owner answers; the shop card fills silently; the map card opens', async () => {
    liveOnly('Speech recognition of the owner’s answer; the answer is typed into the live session')
    await page.getByRole('button', { name: 'Type instead' }).click()
    await page.getByLabel('Message', { exact: true }).fill('name: Market Chai; category: Tea stall')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    // Onboarding v2: answers land in the shop card, no "added" card in the chat.
    await expect(page.getByTestId('shop-so-far')).toContainText('Market Chai')
    await expect(page.getByTestId('agent-action')).toHaveCount(0)
    await expect(page.getByRole('log')).toContainText('Are you at the shop right now?')
    // The coach asked where: the map opens as a card in the chat, waiting for the owner.
    await expect(page.getByTestId('map-card')).toHaveAttribute('data-state', 'open')
    await expect(page.getByRole('button', { name: 'Use my current location' })).toBeVisible()
    await shot(page, 10, '3-action')
  })

  await test.step('4 · the map in the chat: the phone’s location is saved at once; live', async () => {
    // Owner decision (17 Oct): only the browser's prompt, no confirm step in the app.
    await page.getByRole('button', { name: 'Use my current location' }).click()
    const card = page.getByTestId('map-card').last()
    await expect(card).toHaveAttribute('data-state', 'done')
    await expect(card).toContainText('Near Indiranagar')
    await card.scrollIntoViewIfNeeded()
    await evidence(page, 'map-1-small')
    await axe(page)
    // Name, kind and the pin: the shop is live by itself, and the coach asks what is left:
    // first the tea stall's own follow-up (#112), never a generic one.
    await expect(page.getByTestId('shop-live')).toBeVisible()
    expect(await nextQuestion(page, 2)).toBe('followup')
    await expect(page.getByRole('log')).toContainText(FOLLOW_UPS.seating)
    await shot(page, 10, '4-live')
    await axe(page)
  })

  await test.step('5 · the follow-ups, then the shopfront photo in the chat', async () => {
    const send = async (text: string) => {
      await page.getByLabel('Message', { exact: true }).fill(text)
      await page.getByRole('button', { name: 'Send', exact: true }).click()
    }
    await send('Yes, there are two benches')
    await expect(page.getByRole('log')).toContainText('What are your opening hours?')
    await send('hours: 7 am to 9 pm')
    await expect(page.getByRole('log')).toContainText('Can you take a photo of your shop?')
    const camera = page.getByTestId('camera-card')
    // The card is the entry point (with a big Skip); Open camera takes the whole screen, and the
    // voice session keeps listening meanwhile.
    await expect(camera).toContainText('Now your shopfront')
    await expect(camera.getByRole('button', { name: 'Skip for now' })).toBeVisible()
    await camera.getByRole('button', { name: 'Open camera' }).click()
    const modal = page.getByTestId('camera-modal')
    await expect(modal).toHaveAttribute('data-phase', 'live')
    await expect(modal).toContainText('Step back so the sign and the door are in the frame')
    await expect(page.getByTestId('voice-orb').first()).not.toHaveAttribute('data-phase', 'off')
    const box = (await modal.boundingBox())!
    expect(box.height).toBeGreaterThan(844 * 0.95)
    await page.waitForTimeout(500)
    await evidence(page, 'camera-2-viewfinder')
    await modal.getByRole('button', { name: 'Take photo' }).click()
    await expect(modal).toHaveAttribute('data-phase', 'preview')
    await evidence(page, 'camera-3-preview')
    await modal.getByRole('button', { name: 'Retake' }).click()
    await expect(modal).toHaveAttribute('data-phase', 'live')
    await modal.getByRole('button', { name: 'Take photo' }).click()
    await modal.getByRole('button', { name: 'Use photo' }).click()
    await expect(modal).toHaveCount(0)
    await expect(page.getByTestId('camera-card')).toHaveCount(0)
    await expect(page.getByTestId('shop-so-far')).toContainText('Photo added')
    await shot(page, 10, '5-photo')
  })

  await test.step('6 · one summary card, the optional face check, and the review sheet', async () => {
    const summary = page.getByTestId('shop-summary')
    await expect(summary).toContainText('Market Chai')
    await expect(summary).toContainText('Photo added')
    await expect(summary.getByRole('button', { name: 'Verify now' })).toBeVisible()
    await summary.scrollIntoViewIfNeeded()
    await shot(page, 10, '6-summary')
    await axe(page)
    // "Review my shop" is always one tap away (a sheet over the conversation).
    await page.getByRole('button', { name: 'Review my shop' }).click()
    const sheet = page.getByRole('dialog', { name: 'Your shop so far' })
    await expect(sheet.getByTestId('draft-summary')).toContainText('Near Indiranagar')
    await axe(page, 1)
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
  })

  await test.step('7 · "Your shop is ready", and the Google Maps hand-off', async () => {
    await page.getByTestId('shop-summary').getByRole('button', { name: 'Skip for now' }).click()
    await expect(page.getByRole('heading', { name: 'Your shop is ready' })).toBeVisible()
    await shot(page, 10, '7-ready')
    await axe(page)
    const handoff = page.getByTestId('maps-handoff')
    await expect(handoff).toContainText('Put your shop on Google Maps')
    // Honest: the owner submits on Google; nothing claims the shop is on Google.
    await expect(handoff).toContainText('Not on Google yet')
    const open = handoff.getByRole('link', { name: 'Open Google Maps' })
    await expect(open).toHaveAttribute(
      'href',
      'https://www.google.com/maps/search/?api=1&query=12.971823%2C77.641234',
    )
    await expect(open).toHaveAttribute('target', '_blank')
    await handoff.scrollIntoViewIfNeeded()
    await evidence(page, 'map-3-google-handoff')
    await page.getByRole('button', { name: 'Continue with my shop' }).click()
    await expect(page.getByRole('button', { name: /Choose shop: / })).toBeVisible()
  })
})

test('S10 · type it in instead: one question per screen, then Edit details the same way', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  await localOnly(page)
  await inChatFixtures(page)
  await context.grantPermissions(['geolocation', 'microphone'])
  await context.setGeolocation({ latitude: 12.9718234, longitude: 77.6412345, accuracy: 25 })
  await enter(page)
  await page.getByRole('banner').getByRole('button', { name: 'Add shop details' }).click()
  await page.getByRole('button', { name: 'Let’s begin' }).click()
  await expect(page.getByRole('log')).toContainText(FIRST_QUESTION)

  await test.step('1 · from the conversation: "Type it in instead"', async () => {
    await page.getByRole('button', { name: 'Type it in instead' }).click()
    await expect(page).toHaveURL(/step=manual/)
    const journey = page.getByTestId('guided-details')
    await expect(journey).toHaveAttribute('data-step', 'name')
    await expect(page.getByRole('heading', { name: 'What is your shop called?' })).toBeFocused()
    await expect(journey).toContainText('Step 1 of 8')
    // Back (the Back button of the step) is off on the first step; Next is a big target.
    const next = page.getByRole('button', { name: 'Next', exact: true })
    expect((await next.boundingBox())!.height).toBeGreaterThanOrEqual(48)
    await page.getByLabel('Shop name').fill('Courtyard Chai')
    await evidence(page, 'manual-1-name')
    await axe(page)
    await page.getByLabel('Shop name').press('Enter')
  })

  await test.step('2 · kind, items and the map, one screen each', async () => {
    const journey = page.getByTestId('guided-details')
    await expect(journey).toHaveAttribute('data-step', 'category')
    await page.getByRole('button', { name: 'Tea stall' }).click()
    await expect(page.getByLabel('Category')).toHaveValue('Tea stall')
    await evidence(page, 'manual-2-kind')
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(journey).toHaveAttribute('data-step', 'products')
    await page.getByLabel('Product name').fill('Masala chai')
    await page.getByLabel('Price').fill('15')
    await page.getByRole('button', { name: 'Add item' }).click()
    await page.getByLabel('Product name').nth(1).fill('Bun maska')
    await page.getByLabel('Price').nth(1).fill('25')
    await evidence(page, 'manual-3-items')
    await axe(page)
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(journey).toHaveAttribute('data-step', 'location')
    await page.getByRole('button', { name: 'Use my current location' }).click()
    await expect(page.getByTestId('map-card')).toContainText('Near Indiranagar')
    await page.getByRole('button', { name: 'This is my shop' }).click()
    await expect(journey.getByRole('status')).toContainText('Location saved: Near Indiranagar')
    await evidence(page, 'manual-4-location')
    await axe(page)
  })

  await test.step('3 · the step row jumps; payment is a tap; review', async () => {
    const journey = page.getByTestId('guided-details')
    await journey.getByRole('button', { name: 'Payment' }).click()
    await expect(journey).toHaveAttribute('data-step', 'payment')
    await page.getByRole('button', { name: 'Cash', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Cash', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await evidence(page, 'manual-5-payment')
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(journey).toHaveAttribute('data-step', 'delivery')
    await page.getByRole('button', { name: 'Review my shop' }).click()
    const review = page.getByTestId('new-shop-review')
    await expect(review).toContainText('Courtyard Chai')
    await expect(review).toContainText('Masala chai')
    await expect(review).toContainText('Bun maska')
    await expect(review).toContainText('within 25 m')
    await axe(page)
    await page.getByRole('button', { name: 'Open my shop' }).click()
    await expect(page.getByRole('heading', { name: 'Your shop is ready' })).toBeVisible()
    await page.getByRole('button', { name: 'Continue with my shop' }).click()
  })

  await test.step('4 · My shop: the Google Maps hand-off and "Edit details" as a journey', async () => {
    await page.getByRole('button', { name: 'Shop', exact: true }).click()
    await page.getByRole('button', { name: /^Shop details/ }).click()
    await expect(page.getByTestId('maps-handoff')).toContainText('Not on Google yet')
    await page.getByRole('button', { name: 'Edit details' }).click()
    const journey = page.getByRole('dialog', { name: 'Edit details' })
    await expect(journey.getByTestId('guided-details')).toHaveAttribute('data-step', 'name')
    await expect(journey.getByLabel('Shop name')).toHaveValue('Courtyard Chai')
    await journey.getByRole('button', { name: 'Hours' }).click()
    await expect(page.getByRole('heading', { name: 'When are you open?' })).toBeFocused()
    await journey.getByLabel('Hours note (optional)').fill('Closed on public holidays')
    await evidence(page, 'manual-6-edit-hours')
    await axe(page, 1)
    await journey.getByRole('button', { name: 'Review', exact: true }).click()
    const check = page.getByRole('dialog', { name: 'Check before saving' })
    await expect(check).toContainText('Closed on public holidays')
    await check.getByRole('button', { name: 'Confirm and save' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
})

test('S10 · entries: tour end and an empty My shop open the same flow', async ({ page }) => {
  test.setTimeout(90_000)
  await localOnly(page)
  await enter(page)
  await test.step('empty My shop: "Create your shop"', async () => {
    await page.getByRole('button', { name: 'Shop', exact: true }).click()
    await page.getByRole('button', { name: 'Create your shop' }).click()
    await expect(page.getByRole('heading', { name: 'Let’s open your shop' })).toBeVisible()
    await axe(page)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  })
  await test.step('end of the tour: "Start my own shop"', async () => {
    await page.getByRole('button', { name: 'Take the tour' }).click()
    await expect(page.getByRole('dialog', { name: 'Your shop at a glance' })).toBeVisible()
    for (let step = 0; step < 8; step++)
      await page.getByRole('button', { name: 'Next', exact: true }).click()
    await page.getByRole('button', { name: 'Start my own shop' }).click()
    await expect(page.getByRole('heading', { name: 'Let’s open your shop' })).toBeVisible()
    await axe(page)
    await shot(page, 10, '8-from-tour')
  })
})
