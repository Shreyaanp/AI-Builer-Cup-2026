import { readFileSync } from 'node:fs'
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type WebSocketRoute,
} from '@playwright/test'
import { enter, localOnly, shareSigned } from '../stories/support.js'
import { expectCount } from './stamps.js'

/**
 * Release gate for the three flows that must work (owner, 17 Oct): vendor onboarding, a
 * customer's first open, and a customer scanning the shop's QR. Phone (360x800) and desktop,
 * light, English and Hindi. Offline backend, local fixtures, `--workers=1`.
 *
 * Every test records the PR it depends on (annotation `depends-on`). A test whose PR is not in
 * this checkout is skipped with that reason, so the report says what was not run and why.
 */
test.use({ colorScheme: 'light', reducedMotion: 'reduce' })
test.beforeEach(async ({ page }) => {
  await localOnly(page)
})

const LANGUAGES = [
  { name: 'English', code: 'en', locale: 'en-IN' },
  { name: 'Hindi', code: 'hi', locale: 'hi-IN' },
] as const
type Language = (typeof LANGUAGES)[number]

/** True when `needle` is in the checkout's `file`: how a test knows its PR is on this branch. */
function present(file: string, needle: string) {
  try {
    return readFileSync(file, 'utf8').includes(needle)
  } catch {
    return false
  }
}

const onboardingV2 = present('src/features/v1/VoiceStage.tsx', 'shop-live')

/** Records the PR(s) a test depends on; skips it with a clear reason when the PR is absent. */
function dependsOn(pr: string, available = true) {
  test.info().annotations.push({ type: 'depends-on', description: pr })
  test.skip(!available, `Depends on ${pr}, which is not on this branch yet`)
}

async function phoneSize(page: Page) {
  if (test.info().project.name === 'phone') await page.setViewportSize({ width: 360, height: 800 })
}

async function overflowFree(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  )
}

/* ------------------------------ 1. vendor onboarding ------------------------------ */

// The offline coach's questions (backend/app/agent.py), English and Hindi. It opens with the open
// question (#117); the basics follow only when the owner's answer missed them. The record is
// switched to the language under test by `openFlow`.
const ASKED_IN = {
  en: {
    open: 'Can you tell me about your shop?',
    name: 'What is your business called?',
    kind: 'What do you sell?',
    place: 'Are you at the shop right now?',
    hours: 'What are your opening hours?',
    photo: 'Can you take a photo of your shop?',
  },
  hi: {
    open: 'क्या आप अपनी दुकान के बारे में बताएँगे?',
    name: 'आपके कारोबार का नाम क्या है?',
    kind: 'आप क्या बेचते हैं?',
    place: 'क्या आप अभी दुकान पर हैं?',
    hours: 'आपकी दुकान कब से कब तक खुलती है?',
    photo: 'क्या आप अपनी दुकान की फ़ोटो ले सकते हैं?',
  },
}
const ASKED: Record<keyof typeof ASKED_IN.en, string> = { ...ASKED_IN.en }
type Topic = keyof typeof ASKED | 'extra'
// The trade's own follow-up (at most one) that the offline reading may add before the hours.
const EXTRA_QUESTION = new RegExp(
  [
    'Which classes or subjects|Do you stitch for|Which phone brands|How many days ahead',
    'Can customers sit|Which brands do customers',
    'कौन-सी कक्षाएँ|कपड़े सिलते|फ़ोन ठीक करते|कितने दिन पहले|बैठकर चाय|किन ब्रांड',
  ].join('|'),
)

const topicOf = (text: string): Topic | null =>
  (Object.keys(ASKED) as (keyof typeof ASKED)[]).find((key) => text.includes(ASKED[key])) ??
  (EXTRA_QUESTION.test(text) ? 'extra' : null)

async function askedTopics(page: Page) {
  const lines = await page.getByRole('log').locator('li').allInnerTexts()
  return lines.map(topicOf).filter((topic): topic is Topic => topic !== null)
}

/** The coach's next question once more than `count` were asked; null when the summary came. */
async function nextQuestion(page: Page, count: number) {
  let found: Topic | null = null
  await expect
    .poll(
      async () => {
        const asked = await askedTopics(page)
        if (asked.length > count) {
          found = asked.at(-1) ?? null
          return true
        }
        if (await page.getByTestId('shop-summary').isVisible()) {
          found = null
          return true
        }
        return false
      },
      { timeout: 20_000 },
    )
    .toBe(true)
  return found as Topic | null
}

type Copy = Record<string, string>

/** The app's own words in the language under test (so the same spec runs in Hindi). */
async function copyFor(page: Page, code: string): Promise<Copy> {
  return page.evaluate(async (language) => {
    const flow = (await import('/src/features/v1/newShopCopy.ts' as string)) as {
      newShopCopyFor: (l: string) => { begin: string; ready: string }
    }
    const translations = (await import('/src/features/v1/locales/index.ts' as string)) as {
      translations: Record<string, Record<string, string>>
    }
    const strings = (await import('/src/features/v1/strings.ts' as string)) as {
      en: Record<string, string>
    }
    const onboarding = (await import('/src/features/v1/onboardingCopy.ts' as string)) as {
      onboardingCopyFor: (l: string) => Record<string, string>
    }
    const inChat = (await import('/src/features/v1/inChatCopy.ts' as string)) as {
      inChatCopyFor: (l: string) => Record<string, string>
    }
    return {
      ...strings.en,
      ...translations.translations[language],
      begin: flow.newShopCopyFor(language).begin,
      ready: flow.newShopCopyFor(language).ready,
      ...onboarding.onboardingCopyFor(language),
      confirmPin: inChat.inChatCopyFor(language).confirmPin!,
    } as Record<string, string>
  }, code)
}

/** Signs in on the local preview, switches the app to `language`, opens the new-shop flow. */
async function openFlow(page: Page, language: Language) {
  // `enter` signs in with English words, so sign in here in the language under test.
  await page.goto('/')
  const copy = await copyFor(page, language.code)
  Object.assign(ASKED, ASKED_IN[language.code])
  await page.evaluate(
    (code) => localStorage.setItem('niva.starter.preferences', JSON.stringify({ language: code })),
    language.code,
  )
  await page.reload()
  await page.getByRole('button', { name: copy.continuePreview!, exact: true }).click()
  const terms = page.getByLabel(copy.acceptTerms!)
  if (
    await terms.waitFor({ timeout: 5_000 }).then(
      () => true,
      () => false,
    )
  ) {
    await terms.check()
    await page.getByLabel(copy.acceptPrivacy!).check()
    await page.getByRole('button', { name: copy.agree! }).click()
  }
  await page.getByRole('banner').getByRole('button', { name: copy.addShop! }).click()
  await page.getByRole('button', { name: copy.begin! }).click()
  await expect(page.getByRole('log')).toContainText(ASKED.open, { timeout: 20_000 })
  return copy
}

async function say(page: Page, copy: Copy, text: string) {
  await page.getByLabel(copy.message!, { exact: true }).fill(text)
  await page.getByRole('button', { name: copy.send!, exact: true }).click()
}

const DONT_KNOW: Record<string, string> = { en: 'pata nahi', hi: 'मुझे नहीं पता।' }

const businesses = async (page: Page) =>
  (await (await page.request.get('/api/v1/businesses')).json()) as {
    id: string
    public: boolean
    fields: { name: string; category: string; profile?: { kind?: string } }
  }[]

for (const language of LANGUAGES) {
  test.describe(`vendor onboarding · ${language.name}`, () => {
    test.use({ locale: language.locale })

    test('one sentence puts the shop live; no menu or halal question; hours skip; photo Skip; summary; face skip; Today asks for the menu', async ({
      page,
    }) => {
      dependsOn('onboarding v2 (#91)', onboardingV2)
      test.setTimeout(120_000)
      await phoneSize(page)
      const copy = await openFlow(page, language)
      let count = (await askedTopics(page)).length
      // A self-cleaning helmet station: not food. One sentence gives name, kind and area.
      await say(
        page,
        copy,
        'name: Clean Helmet Point; category: self-cleaning helmet station; location: MG Road metro',
      )
      await expect(page.getByTestId('shop-live')).toHaveText(copy.live!)
      await expect(page.getByTestId('shop-so-far')).toContainText('Clean Helmet Point')
      // Nothing already answered is asked; only hours and the photo are left (any order).
      let next = await nextQuestion(page, count)
      expect(['hours', 'photo']).toContain(next)
      const shops = await businesses(page)
      expect(shops).toHaveLength(1)
      expect(shops[0]!.public).toBe(true)
      // "pata nahi" skips the hours (never invented); the photo card has a Skip.
      while (next) {
        count = (await askedTopics(page)).length
        if (next === 'hours') await say(page, copy, DONT_KNOW[language.code]!)
        else {
          const camera = page.getByTestId('camera-card')
          await expect(camera).toBeVisible()
          await camera.getByRole('button', { name: copy.skipForNow!, exact: true }).click()
        }
        next = await nextQuestion(page, count)
      }
      const summary = page.getByTestId('shop-summary')
      await expect(summary).toBeVisible()
      await expect(summary).toContainText('Clean Helmet Point')
      await overflowFree(page)
      const said = (await page.getByRole('log').locator('li').allInnerTexts()).join('\n')
      expect(said).not.toMatch(/halal|vegetarian|veg\b|menu|price|pay|delivery/i)
      for (const question of Object.values(ASKED))
        expect(said.split(question).length - 1, question).toBeLessThanOrEqual(1)
      expect((await businesses(page))[0]!.fields.profile?.kind).toBe('service')
      // The face check is offered and skippable; the shop opens; Today asks for the menu first.
      await expect(summary).toContainText(copy.faceOffer!)
      await summary.getByRole('button', { name: copy.skipForNow!, exact: true }).click()
      await expect(page.getByRole('heading', { name: copy.ready! })).toBeVisible()
      await page.getByRole('button', { name: copy.newShopContinue! }).click()
      const today = page.getByTestId('today-day-one')
      await expect(today).toBeVisible()
      if (language.code === 'en') await expect(today).toContainText('Add what you sell')
      await expect(today.getByRole('button')).not.toHaveCount(0)
    })

    test('GPS pin: "This is my shop" pins the shop and it goes live (name + kind + pin)', async ({
      page,
      context,
    }) => {
      dependsOn('onboarding v2 (#91)', onboardingV2)
      test.setTimeout(90_000)
      await phoneSize(page)
      await context.grantPermissions(['geolocation'])
      await context.setGeolocation({ latitude: 12.9718234, longitude: 77.6412345, accuracy: 20 })
      const copy = await openFlow(page, language)
      const count = (await askedTopics(page)).length
      await say(page, copy, 'name: Gupta Sweets; category: Sweets')
      await expect(page.getByTestId('shop-so-far')).toContainText('Gupta Sweets')
      await expect(page.getByTestId('shop-live')).toHaveCount(0)
      expect(await nextQuestion(page, count)).toBe('place')
      const map = page.getByTestId('map-card')
      await expect(map).toBeVisible()
      // The card opens the big map; "This is my shop" pins it.
      await map.getByRole('button').first().click()
      await page.getByRole('dialog').getByRole('button', { name: copy.confirmPin! }).click()
      await expect(page.getByTestId('shop-live')).toHaveText(copy.live!, { timeout: 20_000 })
      const [shop] = await businesses(page)
      expect(shop!.public).toBe(true)
      await overflowFree(page)
    })

    test('"Review my shop" opens at any moment: while thinking and while a photo saves', async ({
      page,
    }) => {
      dependsOn('onboarding v2 (#91)', onboardingV2)
      test.setTimeout(90_000)
      await phoneSize(page)
      const copy = await openFlow(page, language)
      await say(page, copy, 'name: Patel Kirana')
      await expect(page.getByTestId('shop-so-far')).toContainText('Patel Kirana')
      // Thinking: the next reply is slow on the way.
      await page.route('**/api/v1/coach/stream', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 4_000))
        await route.fallback()
      })
      await say(page, copy, 'category: Grocery')
      await page.getByTestId('review-my-shop').click()
      const review = page.getByTestId('draft-summary')
      await expect(review).toContainText('Patel Kirana', { timeout: 1_500 })
      await page.keyboard.press('Escape')
      await expect(review).toHaveCount(0)
      // The conversation was never cancelled: the shop name is kept and the reply lands.
      await expect(page.getByTestId('shop-so-far')).toContainText('Grocery', { timeout: 15_000 })
    })

    test('"thinking" never stays on: a reply that never comes stops within 12-15 s, message kept, Retry works', async ({
      page,
    }) => {
      dependsOn('onboarding v2 (#91)', onboardingV2)
      test.setTimeout(90_000)
      await phoneSize(page)
      const copy = await openFlow(page, language)
      await page.route('**/api/v1/coach/stream', () => undefined)
      const started = Date.now()
      await say(page, copy, 'name: Stuck Bakery')
      const stalled = page.getByTestId('turn-stalled')
      await expect(stalled).toContainText(copy.tooSlow!, { timeout: 16_000 })
      expect(Date.now() - started).toBeLessThan(16_000)
      await expect(page.getByRole('progressbar')).toHaveCount(0)
      await page.unroute('**/api/v1/coach/stream')
      await stalled.getByRole('button', { name: copy.retry! }).click()
      await expect(page.getByTestId('shop-so-far')).toContainText('Stuck Bakery')
    })

    test('"bas" ends the conversation with a goodbye and nothing more is asked', async ({
      page,
    }) => {
      dependsOn('onboarding v2 (#91)', onboardingV2)
      test.setTimeout(90_000)
      await phoneSize(page)
      const copy = await openFlow(page, language)
      await say(page, copy, 'name: Raju Tailors; category: silai ka kaam')
      await expect(page.getByTestId('shop-so-far')).toContainText('Raju Tailors')
      await say(page, copy, 'bas')
      const ended = page.getByTestId('conversation-ended')
      await expect(ended).toContainText(copy.endedTitle!)
      const asked = (await askedTopics(page)).length
      await page.waitForTimeout(2_000)
      expect((await askedTopics(page)).length).toBe(asked)
      await expect(page.getByRole('progressbar')).toHaveCount(0)
      // Everything said so far is saved; Continue carries on without asking the name again.
      await expect(page.getByTestId('shop-so-far')).toContainText('Raju Tailors')
      await ended.getByRole('button', { name: copy.continueChat! }).click()
      await expect(ended).toHaveCount(0)
      const said = (await page.getByRole('log').locator('li').allInnerTexts()).join('\n')
      expect(said.split(ASKED.name).length - 1).toBeLessThanOrEqual(1)
    })

    test('a reload mid-flow resumes at the next missing field: no new greeting, nothing asked twice', async ({
      page,
    }) => {
      dependsOn('onboarding v2 (#91)', onboardingV2)
      test.setTimeout(90_000)
      await phoneSize(page)
      const copy = await openFlow(page, language)
      await say(page, copy, 'name: Lakshmi Tea Stall; category: chai')
      await expect(page.getByTestId('shop-so-far')).toContainText('Lakshmi Tea Stall')
      await page.reload()
      await page.getByRole('button', { name: copy.continuePreview! }).click()
      const start = page.getByRole('button', { name: copy.begin! })
      const add = page.getByRole('banner').getByRole('button', { name: copy.addShop! })
      await expect(start.or(add)).toBeVisible()
      if (!(await start.isVisible())) await add.click()
      await start.click()
      await expect(page.getByTestId('shop-so-far')).toContainText('Lakshmi Tea Stall')
      await expect(page.getByTestId('map-card')).toBeVisible()
      await page.waitForTimeout(1_500)
      const said = (await page.getByRole('log').locator('li').allInnerTexts()).join('\n')
      expect(said).not.toContain(ASKED.name)
      expect(said).not.toContain(ASKED.kind)
    })
  })
}

/* ---- the voice socket drops mid-flow (a phone losing its network): resume, no repeat ---- */

type Socket = { url: URL; route: WebSocketRoute; server: WebSocketRoute; received: string[] }

async function quietMicrophone(page: Page) {
  await page.context().grantPermissions(['microphone'])
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const audio = new AudioContext()
      const destination = audio.createMediaStreamDestination()
      const tone = audio.createOscillator()
      const quiet = audio.createGain()
      quiet.gain.value = 0
      tone.connect(quiet).connect(destination)
      tone.start()
      return destination.stream
    }
  })
}

for (const language of LANGUAGES) {
  test(`vendor onboarding · ${language.name}: the voice socket drops after an answer is saved; it resumes at the next field, nothing repeated`, async ({
    page,
  }) => {
    dependsOn('onboarding v2 (#91)', onboardingV2)
    test.setTimeout(180_000)
    await phoneSize(page)
    await quietMicrophone(page)
    const sockets: Socket[] = []
    let drop = false
    await page.routeWebSocket('**/api/v1/voice*', (route) => {
      const server = route.connectToServer()
      const socket: Socket = { url: new URL(route.url()), route, server, received: [] }
      sockets.push(socket)
      server.onMessage((message) => {
        if (typeof message === 'string') socket.received.push(message)
        if (!drop) route.send(message)
      })
    })
    const completed = (s: Socket) => s.received.filter((m) => m.includes('"turn_complete"')).length
    async function owner(s: Socket, text: string) {
      const before = completed(s)
      s.server.send(JSON.stringify({ kind: 'text', text }))
      await expect.poll(() => completed(s), { timeout: 30_000 }).toBeGreaterThan(before)
      const replies = s.received
        .map((m) => JSON.parse(m) as { kind: string; text?: string })
        .filter((e) => e.kind === 'reply')
      return replies.at(-1)?.text ?? ''
    }
    const copy = await openFlow(page, language)
    const first = sockets[0]!
    expect(first.url.searchParams.get('lang')).toBe(language.code)
    expect(await owner(first, 'name: Sharma Chai; category: tea stall')).toContain(ASKED.place)
    const card = page.getByTestId('shop-so-far')
    await expect(card).toContainText('Sharma Chai')
    // The server saves the answer, but the network drops before the phone hears back.
    drop = true
    const afterPlace = await owner(first, 'location: Lajpat Nagar')
    // A tea stall may get its one trade question first, then the hours, then the photo.
    const rest = ['hours', 'photo'].find((topic) => afterPlace.includes(ASKED[topic as 'hours']))
      ? afterPlace.includes(ASKED.hours)
        ? 'hours'
        : 'photo'
      : 'extra'
    if (rest === 'extra') expect(afterPlace).toMatch(EXTRA_QUESTION)
    else expect(afterPlace).toContain(ASKED[rest])
    first.route.close({ code: 4000, reason: 'Connection interrupted' })
    drop = false
    // The app reconnects by itself to the same conversation, with no alert and no dead end.
    await expect.poll(() => sockets.length, { timeout: 20_000 }).toBe(2)
    const second = sockets[1]!
    const sid = JSON.parse(first.received.find((m) => m.includes('"ready"'))!).session_id
    expect(second.url.searchParams.get('session_id')).toBe(sid)
    await expect.poll(() => second.received.some((m) => m.includes('"ready"'))).toBe(true)
    expect(second.received.join('\n')).not.toContain('"kind":"error"')
    await expect(card).toContainText('Lajpat Nagar')
    await expect(page.getByTestId('shop-live')).toHaveText(copy.live!)
    await expect(page.getByTestId('voice-alert')).toHaveCount(0)
    // Silent resume, then the next missing field, never an answered one.
    await page.waitForTimeout(2_000)
    expect(second.received.filter((m) => m.includes('"kind":"reply"'))).toHaveLength(0)
    const next = await owner(second, DONT_KNOW[language.code]!)
    if (rest !== 'photo') expect(next).toContain(rest === 'hours' ? ASKED.photo : ASKED.hours)
    for (const done of [ASKED.name, ASKED.kind, ASKED.place]) expect(next).not.toContain(done)
    if (rest !== 'extra') expect(next).not.toContain(ASKED[rest])
    expect(await businesses(page)).toHaveLength(1)
  })
}

/* ------------------------------ 2. customer first open ------------------------------ */

const shopId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const bangalore = { latitude: 12.9718234, longitude: 77.6412345, accuracy: 20 }

async function fixtures(page: Page) {
  const shop = {
    id: shopId,
    name: 'Indiranagar Filter Kaapi',
    source: 'chalkboard',
    category: 'cafe',
    lat: bangalore.latitude + 0.001,
    lng: bangalore.longitude,
    distance_m: 120,
    open_now: true,
    currency: 'INR',
    demo: false,
    demo_shop: true,
    items: [{ name: 'Filter coffee', price: 3000, unit: 'cup', available: true }],
    sold_out: [],
  }
  await page.route('**/api/v1/discover?**', (route) =>
    route.fulfill({ json: { mode: 'demo', places: [shop], google_unavailable: false } }),
  )
  await page.route('**/api/v1/discover/ask', (route) =>
    route.fulfill({
      json: {
        intent: {
          summary: '',
          keywords: ['coffee'],
          category: '',
          max_price: null,
          halal: false,
          vegetarian: false,
          locally_made: false,
          open_now: false,
          followups: [],
          sort: 'best',
          near: '',
          deals: false,
        },
        mode: 'keywords',
        groups: [{ id: 'best', places: [{ ...shop, matched: shop.items, reasons: [] }] }],
        anchor: null,
      },
    }),
  )
  await page.route('**/api/v1/public/shops/*', (route) =>
    route.fulfill({
      json: {
        id: shopId,
        name: shop.name,
        timezone: 'Asia/Kolkata',
        category: 'Cafe',
        location: 'Indiranagar',
        currency: 'INR',
        hours: '07:00–19:00',
        reward_text: 'A free coffee',
        stamps_needed: 8,
        products: [{ name: 'Filter coffee', price: 3000, unit: 'cup', available: true }],
      },
    }),
  )
  return shop
}

for (const language of LANGUAGES) {
  test.describe(`customer first open · ${language.name}`, () => {
    test.use({ locale: language.locale })

    test('first open: the language follows the phone (and can be changed), then the front door ask gives results fast; the shop opens and Back keeps the question and the results', async ({
      page,
    }) => {
      dependsOn('#60 front door')
      test.setTimeout(90_000)
      await phoneSize(page)
      const shop = await fixtures(page)
      await page.goto('/explore/')
      // A sensible default language from the first paint, and the picker is one tap away.
      await expect(page.locator('html')).toHaveAttribute('lang', language.code)
      const composer = page.getByRole('search').getByRole('textbox')
      await expect(composer).toBeVisible({ timeout: 30_000 })
      const picker = page.getByRole('button', { name: /^(Language|भाषा)/ }).first()
      await expect(picker).toBeVisible()
      await picker.click()
      await expect(page.getByRole('menuitem', { name: 'हिन्दी', exact: true })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: 'English', exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await overflowFree(page)
      // Front door ask → results within the budget.
      const question = language.code === 'hi' ? 'कॉफ़ी' : 'coffee'
      const asked = Date.now()
      await composer.fill(question)
      await composer.press('Enter')
      const result = page.locator(`a[href="/explore/s/${shopId}"]`).first()
      await expect(result).toBeVisible({ timeout: 5_000 })
      expect(Date.now() - asked, 'ask → results budget (ms)').toBeLessThan(5_000)
      await expect(result).toContainText(shop.name)
      // The shop page opens; Back returns to the same conversation, not an empty front door.
      await result.click()
      await expect(page).toHaveURL(new RegExp(`/explore/s/${shopId}`))
      await expect(page.getByRole('heading', { level: 1, name: shop.name })).toBeVisible()
      await page.goBack()
      await expect(page.getByText(question).first()).toBeVisible()
      await expect(page.locator(`a[href="/explore/s/${shopId}"]`).first()).toBeVisible()
    })

    test('first open with location allowed: the current location is used and there is no free-text location box', async ({
      page,
      context,
    }) => {
      // The Ask home uses the phone's place only after a tap on "Use my location" today.
      dependsOn(
        'automatic location when permission is already granted (not on main yet)',
        present('src/features/discover/AskHome.tsx', 'permissions.query'),
      )
      test.setTimeout(60_000)
      await phoneSize(page)
      await context.grantPermissions(['geolocation'])
      await context.setGeolocation(bangalore)
      await fixtures(page)
      await page.route('**/api/v1/discover/place?**', (route) =>
        route.fulfill({
          json: { lat: bangalore.latitude, lng: bangalore.longitude, label: 'Indiranagar' },
        }),
      )
      await page.goto('/explore/')
      await expect(page.getByRole('search').getByRole('textbox')).toBeVisible({ timeout: 30_000 })
      // Permission is already granted: no "Use my location" tap, no "search any city" box, and
      // the area chip names the phone's place, never the demo default.
      await expect(page.getByRole('textbox', { name: /city|neighbourhood|शहर/i })).toHaveCount(0)
      await expect(page.getByRole('button', { name: /Use my location|मेरी लोकेशन/ })).toHaveCount(0)
      await expect(page.getByRole('button', { name: /Tiong Bahru/ })).toHaveCount(0)
    })
  })
}

/* ------------------------------ 3. the shop's QR ------------------------------ */

type Pin = { lat: number; lng: number }

/** A shop with a reward and a pin of its own, set up through the owner API like a real owner. */
async function seedPinnedShop(page: Page, name: string, at: Pin, extra: object) {
  const business = {
    name,
    category: 'Bakery',
    location: 'Tiong Bahru, Singapore',
    currency: 'SGD',
    timezone: 'Asia/Singapore',
    ...extra,
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
  const shop = await apply({
    kind: 'business',
    revision: 0,
    geocode_confirmed: true,
    business,
    products: [],
  })
  await apply({
    kind: 'business',
    business_id: shop.id,
    revision: shop.revision,
    business: { ...business, ...at },
    products: [],
  })
  await page.reload()
  await page.getByRole('button', { name: 'Continue local preview' }).click()
  await expect(page.getByRole('button', { name: `Choose shop: ${name}` })).toBeVisible()
}

/** A customer's phone standing at the pin (its own context: nothing shared with the owner). */
async function customerAt(browser: Browser, at: Pin, signedIn: boolean) {
  const info = test.info()
  const viewport =
    info.project.name === 'phone' ? { width: 360, height: 800 } : { width: 1440, height: 1000 }
  const context: BrowserContext = await browser.newContext({
    baseURL: info.project.use.baseURL,
    viewport,
    isMobile: viewport.width < 600,
    hasTouch: viewport.width < 600,
    locale: 'en-IN',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    permissions: ['geolocation'],
    geolocation: { latitude: at.lat, longitude: at.lng, accuracy: 15 },
  })
  const page = await context.newPage()
  await localOnly(page)
  if (signedIn) {
    const session = await page.request.post(`${info.project.use.baseURL}/api/v1/customer/session`, {
      data: { name: 'Asha' },
    })
    expect(session.ok(), await session.text()).toBe(true)
  }
  return { context, page }
}

const quietPin = (): Pin => ({ lat: 1.2 + Math.random() * 0.1, lng: 103.7 + Math.random() * 0.1 })

for (const who of ['guest', 'signed-in customer'] as const) {
  test(`QR scan as a ${who}: one stamp, the same count (2 welcome + 1) on the shop button, card and passport; a second scan the same day adds none`, async ({
    page,
    browser,
  }) => {
    dependsOn('#63 welcome stamps')
    test.setTimeout(120_000)
    await enter(page)
    const name = `QR Kaya ${Date.now().toString().slice(-6)}`
    const at = quietPin()
    await seedPinnedShop(page, name, at, {
      reward_text: 'A free kaya bun',
      stamps_needed: 10,
    })
    const { qr } = await shareSigned(page)
    const { context, page: customer } = await customerAt(browser, at, who !== 'guest')
    try {
      const shopUrl = new URL(qr)
      shopUrl.search = ''
      // Before any scan the card already holds the 2 welcome stamps.
      await expectCount(customer, shopUrl, name, 2, 12, false)
      // The signed QR: a stamp (3 = 2 welcome + 1), then the same 3 everywhere.
      await customer.goto(qr)
      const moment = customer.getByRole('dialog')
      await expect(moment.getByRole('button', { name: 'Done' })).toBeVisible({ timeout: 20_000 })
      await moment.getByRole('button', { name: 'Done' }).click()
      await expect(moment).toBeHidden()
      await expect(customer).not.toHaveURL(/[?&]k=/)
      await expectCount(customer, shopUrl, name, 3, 12)
      // A second scan the same day: honest, and no extra stamp.
      await customer.goto(qr)
      await expect(
        customer.getByRole('dialog').getByRole('heading', { name: 'Already stamped today' }),
      ).toBeVisible({ timeout: 20_000 })
      await customer.getByRole('dialog').getByRole('button', { name: 'Done' }).click()
      await expectCount(customer, shopUrl, name, 3, 12)
      await overflowFree(customer)
    } finally {
      await context.close()
    }
  })
}

test('a shop with no reward shows no stamps: no card, no button, no passport tile, and a scan gives nothing', async ({
  page,
  browser,
}) => {
  dependsOn('#63 welcome stamps')
  test.setTimeout(120_000)
  await enter(page)
  const name = `No Reward Repairs ${Date.now().toString().slice(-6)}`
  const at = quietPin()
  await seedPinnedShop(page, name, at, { category: 'Repair', reward_text: '' })
  const { qr } = await shareSigned(page)
  const { context, page: customer } = await customerAt(browser, at, false)
  try {
    const shopUrl = new URL(qr)
    shopUrl.search = ''
    await customer.goto(qr)
    await expect(customer.getByRole('heading', { level: 1, name })).toBeVisible({ timeout: 20_000 })
    await expect(customer.getByRole('region', { name: 'Stamp card' })).toHaveCount(0)
    await expect(customer.getByRole('link', { name: /^Stamp card · / })).toHaveCount(0)
    await expect(customer.getByText(/\d+ stamps?/)).toHaveCount(0)
    await customer.goto(`${shopUrl.origin}/explore/passport`)
    await expect(customer.locator('li').filter({ hasText: name })).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test('claiming a full card needs sign-in', async ({ page, browser }) => {
  dependsOn('owner brief 17 Oct: claim needs sign-in')
  // A card fills one stamp per day (the 2 welcome stamps are extra slots, not card stamps), so
  // a local run cannot reach a full card without seeding passport state directly.
  test.skip(true, 'Needs a seeded full card: one scan a day cannot fill it in a local run')
  test.setTimeout(120_000)
  await enter(page)
  const name = `Full Card Kopi ${Date.now().toString().slice(-6)}`
  const at = quietPin()
  // Two stamps are welcome stamps: one scan completes a card of 3.
  await seedPinnedShop(page, name, at, { reward_text: 'A free kopi', stamps_needed: 3 })
  const { qr } = await shareSigned(page)
  const guest = await customerAt(browser, at, false)
  try {
    await guest.page.goto(qr)
    await guest.page
      .getByRole('dialog')
      .getByRole('button', { name: 'Done' })
      .click({ timeout: 20_000 })
    const card = guest.page.getByRole('region', { name: 'Stamp card' })
    await expect(card.getByRole('status')).toHaveText('3 stamps')
    await card.getByRole('button', { name: 'Claim reward', exact: true }).click()
    // A guest cannot redeem: the sign-in comes first and nothing is marked as used.
    await expect(guest.page.getByRole('button', { name: /Continue with Google/ })).toBeVisible()
    await expect(
      guest.page.getByRole('button', { name: 'Staff: mark as used', exact: true }),
    ).toHaveCount(0)
  } finally {
    await guest.context.close()
  }
})
