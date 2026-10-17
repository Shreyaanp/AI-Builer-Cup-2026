import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// Account 2 customer story: ask → open a shop → follow → sign in to chat → labelled demo
// reply → Chats and Saved. Local dev seeds the same tour story before serving.
const SHOP = 'demo-story-singapore-bakery'
const shots = (name: string) => `docs/stories/${name}.png`

test.beforeEach(async ({ page, request }) => {
  const seeded = await request.get(`/api/v1/public/shops/${SHOP}`)
  expect(seeded.ok(), 'Local dev must seed the tour story before serving').toBeTruthy()
  await page.addInitScript(() => {
    localStorage.setItem('chalkboard.customer.journey', 'done')
    localStorage.setItem(
      'chalkboard.discover.filters',
      JSON.stringify({
        place: {
          lat: 1.3052,
          lng: 103.9045,
          label: 'Katong',
        },
      }),
    )
  })
  await page.route('**/*', (route) =>
    ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
      ? route.continue()
      : route.abort(),
  )
})

async function axe(page: Page) {
  await page.waitForTimeout(900) // let entrance motion settle before checking contrast
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(result.violations).toEqual([])
}

test('customer story: ask, follow, sign in to chat, demo reply, Chats and Saved', async ({
  page,
  isMobile,
}) => {
  test.setTimeout(90_000)
  const shot = async (name: string) => {
    if (isMobile) await page.screenshot({ path: shots(name) })
  }

  // 1. Ask the AI. No account needed.
  await page.goto('/explore/')
  await expect(page.getByRole('heading', { name: 'What are you looking for nearby?' })).toBeVisible(
    {
      timeout: 30_000,
    },
  )
  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav.getByRole('link', { name: 'Ask' })).toHaveAttribute('aria-current', 'page')
  await shot('C-1-ask')
  await page.getByRole('textbox', { name: 'Ask about anything nearby' }).fill('croissant in Katong')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const answers = page.getByRole('article', { name: 'croissant in Katong' })
  await expect(answers.getByRole('link').first()).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(1600)
  await shot('C-2-results')

  // 2. Open the shop (from the results when it is there, else directly).
  const card = page.locator(`a[href="/explore/s/${SHOP}"]`).first()
  if (await card.isVisible()) await card.click()
  else await page.goto(`/explore/s/${SHOP}`)
  const name = 'Crumb & Courtyard (Demo)'
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible({ timeout: 15_000 })

  // 3. Follow while signed out: kept on this device.
  const follow = page.getByRole('button', { name: `Follow ${name}` })
  if (await follow.isVisible()) await follow.click()
  await expect(page.getByRole('button', { name: `Unfollow ${name}` })).toBeVisible()
  await shot('C-3-shop-followed')
  await axe(page)

  // 4. Messaging the owner needs sign-in; the question carries over.
  await page.getByRole('button', { name: 'Chat with the shop' }).click()
  await page.getByRole('button', { name: 'Hours' }).click()
  await page.getByRole('button', { name: 'Ask the owner' }).last().click()
  await expect(page.getByText('Owners reply to a real person')).toBeVisible()
  await shot('C-4-sign-in')
  await page.getByRole('button', { name: /Continue with Google/ }).click()
  await expect(page.getByText(/Signed in as/)).toBeVisible()
  const message = page.getByRole('textbox', { name: 'Message' })
  await message.fill('Do you have butter croissants this afternoon?')
  await page.getByRole('button', { name: 'Send message' }).click()

  // 5. The thread: an AI instant answer, then a clearly labelled automatic demo reply.
  await expect(page).toHaveURL(new RegExp(`/explore/chats/${SHOP}/`))
  await expect(page.getByText('Do you have butter croissants this afternoon?').last()).toBeVisible()
  await expect(page.getByText('Demo reply').last()).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(600)
  await shot('C-5-thread-demo-reply')
  await axe(page)

  // 6. Chats lists the thread; Saved shows the followed shop and its updates.
  // A thread is full screen, like a messaging app; Back returns to the list.
  await page.getByRole('link', { name: 'Back' }).click()
  await expect(page.getByRole('heading', { name: 'Chats', level: 1 })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Chats' }).getByText(name)).toBeVisible()
  await page.waitForTimeout(1200)
  await shot('C-6-chats')
  await axe(page)
  await nav.getByRole('link', { name: 'Saved' }).click()
  await expect(page.getByRole('heading', { name: 'Saved', level: 1 })).toBeVisible()
  const following = page.getByRole('region', { name: 'Following' })
  await expect(following.getByText(name)).toBeVisible()
  const updates = page.getByRole('region', { name: 'Updates' })
  await expect(updates.getByText('Demo update').first()).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(1200)
  await shot('C-7-saved-updates')
  await axe(page)
})

test('reduced motion: the thread and Saved still work without animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`/explore/s/${SHOP}`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Chat with the shop' }).click()
  await page.getByRole('button', { name: 'Ask the owner' }).first().click()
  await page.getByRole('button', { name: /Continue with Google/ }).click()
  await page.getByRole('textbox', { name: 'Message' }).fill('Are you open on Sunday?')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page).toHaveURL(new RegExp(`/explore/chats/${SHOP}/`))
  await expect(page.getByText('Demo reply').last()).toBeVisible({ timeout: 20_000 })
  // Nothing in the customer screens keeps a running animation under reduced motion.
  const running = await page.evaluate(
    () =>
      document
        .getAnimations()
        .filter((a) => a.playState === 'running' && Number(a.effect?.getTiming().duration ?? 0) > 1)
        .length,
  )
  expect(running).toBe(0)
})

test('personalisation: stated preferences are remembered, rank For you, and can be cleared', async ({
  page,
  isMobile,
}) => {
  test.setTimeout(60_000)
  await page.goto('/explore/')
  await expect(page.getByRole('heading', { name: 'What are you looking for nearby?' })).toBeVisible(
    {
      timeout: 30_000,
    },
  )
  // Sign in (local stand-in for Google) and follow the demo bakery.
  expect(
    (await page.request.post('/api/v1/customer/session', { data: { name: 'Asha' } })).ok(),
  ).toBeTruthy()
  expect((await page.request.put(`/api/v1/customer/follows/${SHOP}`)).ok()).toBeTruthy()
  await page.reload()
  await page
    .getByRole('textbox', { name: 'Ask about anything nearby' })
    .fill("I'm vegetarian, croissant in Katong")
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Remembered:' })).toContainText(
    'Vegetarian',
    { timeout: 15_000 },
  )
  // "For you" picks lead the answer, each saying why.
  const forYou = page.getByRole('article', { name: "I'm vegetarian, croissant in Katong" })
  await expect(forYou.getByText(/You follow this shop|Vegetarian options/).first()).toBeVisible()
  await page.waitForTimeout(1600)
  if (isMobile) await page.screenshot({ path: shots('C-8-for-you') })
  await axe(page)
  await page.getByRole('button', { name: 'Manage' }).click()
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByText('Vegetarian', { exact: true })).toBeVisible()
  await page.waitForTimeout(600)
  if (isMobile) await page.screenshot({ path: shots('C-9-profile') })
  await sheet.getByRole('button', { name: 'Clear preferences and searches' }).click()
  await expect(sheet.getByText('Cleared. Follows stay until you unfollow.')).toBeVisible()
})
