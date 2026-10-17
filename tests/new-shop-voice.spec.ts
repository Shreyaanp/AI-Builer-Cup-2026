import { AxeBuilder } from '@axe-core/playwright'
import { FIRST_QUESTION } from './newShopTopics.js'
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'
import { enter, localOnly } from './stories/support.js'

// The new-shop conversation as a "voice mode": one open conversation (the mic stays on), a chalk
// orb that reacts to who is talking, the shop card filling up, the conversation on the same
// screen, seamless reconnects and a clear alert for every failure. Offline backend; the Live
// socket is proxied so the tests can play the coach's audio and end sessions like the server.
test.use({ reducedMotion: 'reduce' })
test.beforeEach(async ({ page }, info) => {
  await localOnly(page)
  // Phone evidence at the owner's reference size.
  if (info.project.name === 'phone') await page.setViewportSize({ width: 390, height: 844 })
})

/** `sheet`: the one sheet the flow has, "Review my shop" (owner decision, 17 Oct). */
async function audit(page: Page, sheet = false) {
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  )
  // Nothing else in the flow is a modal, dialog or sheet (alerts sit in the page).
  await expect(page.getByRole('dialog')).toHaveCount(sheet ? 1 : 0)
}

/** The browser refuses the microphone, the same on every machine (CI has no audio device, which
 * would otherwise read as "no microphone" instead of "blocked"). */
async function blockedMicrophone(page: Page) {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('Permission denied', 'NotAllowedError')
    }
  })
}

/** A granted microphone that hears silence (so "thinking" is not mistaken for talking). */
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

/** Half a second of the coach's voice per call, as Live sends it (24 kHz PCM16). */
function coachAudio(seconds = 2.5) {
  const rate = 24000
  const samples = Math.floor(rate * seconds)
  const pcm = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    const t = i / rate
    pcm.writeInt16LE(
      Math.round(Math.sin(t * 2 * Math.PI * 220) * Math.abs(Math.sin(t * 5)) * 12000),
      i * 2,
    )
  }
  return pcm
}

type Live = {
  sockets: { url: URL; route: WebSocketRoute }[]
  ready: string[]
  holdNextReady: (ms: number) => void
  current: () => WebSocketRoute
}

/** Proxies the Live socket to the offline server, recording each socket and its session id. */
async function proxyLive(page: Page): Promise<Live> {
  const live: Live = {
    sockets: [],
    ready: [],
    holdNextReady: (ms) => (hold = ms),
    current: () => live.sockets.at(-1)!.route,
  }
  let hold = 0
  await page.routeWebSocket('**/api/v1/voice*', (route) => {
    live.sockets.push({ url: new URL(route.url()), route })
    const server = route.connectToServer()
    server.onMessage((message) => {
      if (typeof message === 'string' && message.includes('"kind":"ready"')) {
        live.ready.push(JSON.parse(message).session_id)
        const wait = hold
        hold = 0
        if (wait) return void setTimeout(() => route.send(message), wait)
      }
      route.send(message)
    })
  })
  return live
}

async function openFlow(page: Page) {
  await page.getByRole('banner').getByRole('button', { name: 'Add shop details' }).click()
  await expect(page.getByRole('heading', { name: 'Let’s open your shop' })).toBeVisible()
}

const orb = (page: Page) => page.getByTestId('voice-orb').first()

for (const scheme of ['light', 'dark'] as const) {
  test(`every voice-mode state, on screen (${scheme})`, async ({ page }, info) => {
    test.setTimeout(180_000)
    await page.addInitScript((appearance) => {
      localStorage.setItem('niva.starter.preferences', JSON.stringify({ appearance }))
    }, scheme)
    await quietMicrophone(page)
    const live = await proxyLive(page)
    await enter(page)
    const desktop = info.project.name === 'desktop' ? '-desktop' : ''
    const capture = async (step: string, sheet = false) => {
      await audit(page, sheet)
      await page.evaluate(async () => {
        await document.fonts.ready
      })
      await page.screenshot({
        path: `docs/stories/new-shop-${step}-${scheme}${desktop}.png`,
        animations: 'disabled',
      })
    }

    await openFlow(page)
    await capture('1-hero')
    await page.getByRole('button', { name: 'Let’s begin' }).click()

    // Listening: the coach greeted, the mic is on (not paused) and stays on.
    await expect(page.getByRole('log')).toContainText(FIRST_QUESTION)
    await expect(orb(page)).toHaveAttribute('data-phase', 'listening')
    const mic = page.getByRole('button', { name: 'Pause the mic' })
    await expect(mic).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByRole('status')).toHaveText('Listening… just talk')
    await expect(page.getByTestId('shop-so-far')).toContainText('What you tell me appears here.')

    // Thinking: the owner has said something and stopped; the coach is due. (Straight away, so
    // the coach's own nudge after ~9 s of silence does not join the scripted turns.)
    live.current().send(JSON.stringify({ kind: 'input_transcript', text: 'I sell masala chai' }))
    await expect(page.getByTestId('captions')).toContainText('I sell masala chai')
    await expect(orb(page)).toHaveAttribute('data-phase', 'thinking')
    await expect(page.getByRole('status')).toHaveText('Thinking…')
    await capture('3-thinking')

    // Speaking: the coach's real audio plays; its words are captioned and kept in the chat.
    live.current().send(
      JSON.stringify({
        kind: 'output_transcript',
        text: 'Lovely, masala chai! What do you call your shop?',
      }),
    )
    live.current().send(coachAudio(6))
    await expect(orb(page)).toHaveAttribute('data-phase', 'speaking')
    // The caption follows the voice: the question's words arrive as they are said.
    await expect(page.getByTestId('captions')).toContainText('What do you call your shop?', {
      timeout: 10_000,
    })
    await capture('4-speaking')
    live.current().send(JSON.stringify({ kind: 'turn_complete' }))
    await expect(page.getByRole('log')).toContainText('What do you call your shop?')
    await expect(orb(page)).toHaveAttribute('data-phase', 'listening', { timeout: 10_000 })
    await expect(page.getByRole('status')).toHaveText('Listening… just talk')
    await capture('2-listening')

    // Reconnecting: the Live session ends (its time cap); the same conversation comes back.
    live.holdNextReady(1500)
    live.current().close({ code: 1001, reason: 'SESSION_TIMEOUT' })
    await expect(orb(page)).toHaveAttribute('data-phase', 'reconnecting')
    await expect(page.getByRole('status')).toHaveText('Reconnecting…')
    await capture('5-reconnecting')
    await expect(orb(page)).toHaveAttribute('data-phase', 'listening', { timeout: 10_000 })
    expect(live.sockets[1]!.url.searchParams.get('session_id')).toBe(live.ready[0])

    // Typing: the keyboard opens the composer; the answer fills the shop card.
    await page.getByRole('button', { name: 'Type instead' }).click()
    const message = page.getByLabel('Message', { exact: true })
    await expect(message).toBeFocused()
    await message.fill('name: Chai Corner; category: Tea stall; location: Indiranagar')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const card = page.getByTestId('shop-so-far')
    await expect(card).toContainText('Chai Corner')
    await expect(card.locator('[data-filled="true"]', { hasText: 'Indiranagar' })).toHaveCount(1)
    // Name, kind and place: the shop is live by itself.
    await expect(page.getByTestId('shop-live')).toBeVisible()
    await capture('7-typing')
    await page.getByRole('button', { name: 'Talk instead' }).click()
    await expect(page.getByRole('button', { name: 'Pause the mic' })).toBeVisible()

    // "Review my shop" is a sheet over the conversation; closing it returns to the same step.
    await page.getByRole('button', { name: 'Review my shop' }).click()
    await expect(page.getByTestId('draft-summary')).toContainText('Chai Corner')
    await capture('8-review', true)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('draft-summary')).toHaveCount(0)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Your shop is ready' })).toBeFocused()
    await capture('9-ready')
  })

  test(`blocked microphone: an alert with what to do, and typing meanwhile (${scheme})`, async ({
    page,
  }, info) => {
    await page.addInitScript((appearance) => {
      localStorage.setItem('niva.starter.preferences', JSON.stringify({ appearance }))
    }, scheme)
    // No microphone permission in this context: the browser refuses it.
    await blockedMicrophone(page)
    await enter(page)
    await openFlow(page)
    await page.getByRole('button', { name: 'Let’s begin' }).click()
    const alert = page.getByTestId('voice-alert')
    await expect(alert).toContainText('Your microphone is blocked')
    await expect(alert).toContainText('tap the lock icon next to the web address')
    await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible()
    await expect(alert.getByRole('button', { name: 'Type instead' })).toBeVisible()
    await expect(alert.getByRole('button', { name: 'Close' })).toBeVisible()
    // The coach still opens the conversation, by text, and the composer is there.
    await expect(page.getByRole('log')).toContainText(FIRST_QUESTION)
    await expect(page.getByLabel('Message', { exact: true })).toBeVisible()
    await audit(page)
    const desktop = info.project.name === 'desktop' ? '-desktop' : ''
    await page.screenshot({
      path: `docs/stories/new-shop-6-mic-blocked-${scheme}${desktop}.png`,
      animations: 'disabled',
    })
    // Still blocked: "Try again" says so again instead of failing silently.
    await alert.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByTestId('voice-alert')).toContainText('Your microphone is blocked')
    await page.getByTestId('voice-alert').getByRole('button', { name: 'Type instead' }).click()
    await expect(page.getByTestId('voice-alert')).toHaveCount(0)
    const message = page.getByLabel('Message', { exact: true })
    await expect(message).toBeFocused()
    await message.fill('name: Corner Bakery; category: Bakery')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByTestId('shop-so-far')).toContainText('Corner Bakery')
  })
}

test('a microphone the browser already blocks is explained before any session opens', async ({
  page,
}) => {
  let sockets = 0
  await page.routeWebSocket('**/api/v1/voice*', (route) => {
    sockets += 1
    route.connectToServer()
  })
  await page.addInitScript(() => {
    const query = navigator.permissions.query.bind(navigator.permissions)
    navigator.permissions.query = (async (descriptor: PermissionDescriptor) =>
      descriptor.name === ('microphone' as PermissionName)
        ? ({ state: 'denied' } as PermissionStatus)
        : query(descriptor)) as typeof navigator.permissions.query
  })
  await enter(page)
  await openFlow(page)
  await page.getByRole('button', { name: 'Let’s begin' }).click()
  await expect(page.getByTestId('voice-alert')).toContainText('Your microphone is blocked')
  await expect(page.getByRole('log')).toContainText(FIRST_QUESTION)
  await page.getByTestId('voice-alert').getByRole('button', { name: 'Close' }).click()
  await expect(page.getByTestId('voice-alert')).toHaveCount(0)
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible()
  expect(sockets).toBe(0)
})

test('session end: the app reconnects to the same conversation and it carries on', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await quietMicrophone(page)
  const live = await proxyLive(page)
  await enter(page)
  await openFlow(page)
  await page.getByRole('button', { name: 'Let’s begin' }).click()
  await expect(page.getByRole('log')).toContainText(FIRST_QUESTION)
  await expect(orb(page)).toHaveAttribute('data-phase', 'listening')
  const first = live.ready[0]
  expect(first).toBeTruthy()
  // Twice, like a long conversation that outlives two Live sessions.
  for (const round of [1, 2]) {
    live.current().close({ code: 1001, reason: 'SESSION_TIMEOUT' })
    await expect.poll(() => live.ready.length).toBe(round + 1)
    await expect(orb(page)).toHaveAttribute('data-phase', 'listening')
    expect(live.sockets[round]!.url.searchParams.get('session_id')).toBe(first)
    expect(live.ready[round]).toBe(first)
  }
  // The mic never turned itself off and no alert appeared.
  await expect(page.getByRole('button', { name: 'Pause the mic' })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await expect(page.getByTestId('voice-alert')).toHaveCount(0)
  // The conversation carries on in the same session: the greeting is still there, an answer
  // (typed into the live session) is acted on, and the server has both turns in one history.
  await page.getByRole('button', { name: 'Type instead' }).click()
  await page.getByLabel('Message', { exact: true }).fill('name: Night Owl Kopi; category: Cafe')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByTestId('shop-so-far')).toContainText('Night Owl Kopi')
  await expect(page.getByRole('log')).toContainText(FIRST_QUESTION)
  const history = await (await page.request.get(`/api/v1/conversations/${first}`)).json()
  const said = history.messages.map((item: { text: string }) => item.text).join('\n')
  expect(said).toContain('Hello! I want to open a new shop.')
  expect(said).toContain('name: Night Owl Kopi; category: Cafe')
})

test('lost connection: retries by itself, then a calm "Voice paused" with Retry; typing carries on', async ({
  page,
}) => {
  test.setTimeout(150_000)
  await quietMicrophone(page)
  let fail = false
  let sockets = 0
  await page.routeWebSocket('**/api/v1/voice*', (route) => {
    sockets += 1
    if (fail) return void route.close({ code: 4000, reason: 'Connection interrupted' })
    route.connectToServer()
  })
  await enter(page)
  await openFlow(page)
  await page.getByRole('button', { name: 'Let’s begin' }).click()
  await expect(orb(page)).toHaveAttribute('data-phase', 'listening')
  fail = true
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  await expect(orb(page)).toHaveAttribute('data-phase', 'reconnecting')
  const alert = page.getByTestId('voice-alert')
  // Eight retries with growing pauses (about 45 seconds), then a calm pause, never a dead end.
  await expect(alert).toContainText('Voice paused', { timeout: 60_000 })
  await expect(alert).toContainText('We carry on from the same question')
  expect(sockets).toBe(9)
  await expect(alert.getByRole('button', { name: 'Type instead' })).toBeVisible()
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible()
  await audit(page)
  // Back online: "Retry" brings voice back in the same conversation.
  fail = false
  await alert.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByTestId('voice-alert')).toHaveCount(0)
  // The mic is live again (a reply typed meanwhile may still be read aloud first).
  await expect(page.getByRole('button', { name: 'Pause the mic' })).toBeVisible()
  await expect(orb(page)).toHaveAttribute('data-phase', 'listening', { timeout: 30_000 })
})

test('voice rate limit: the alert says how long to wait; voice unavailable: carry on typing', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await quietMicrophone(page)
  let mode: 'limited' | 'down' = 'limited'
  await page.routeWebSocket('**/api/v1/voice*', (route) => {
    if (mode === 'limited') {
      route.send(JSON.stringify({ kind: 'error', code: 'RATE_LIMITED', data: { retry_after: 2 } }))
      return void route.close({ code: 1008, reason: 'RATE_LIMITED' })
    }
    route.send(JSON.stringify({ kind: 'error', code: 'PROVIDER_UNAVAILABLE' }))
    route.close({ code: 1011, reason: 'PROVIDER_UNAVAILABLE' })
  })
  await enter(page)
  await openFlow(page)
  await page.getByRole('button', { name: 'Let’s begin' }).click()
  const alert = page.getByTestId('voice-alert')
  await expect(alert).toContainText('Voice is busy')
  await expect(alert).toContainText(/Try again in [12] s/)
  const retry = alert.getByRole('button', { name: 'Try again' })
  await expect(retry).toBeDisabled()
  // The greeting is created by the conversation bootstrap, independently of the voice socket.
  // Poll its coach transcript until it is actually rendered; CI can take longer than 15 s here.
  await expect(page.getByRole('log', { name: 'Coach' })).toContainText(FIRST_QUESTION, {
    timeout: 30_000,
  })
  await expect(retry).toBeEnabled({ timeout: 5_000 })
  mode = 'down'
  await retry.click()
  await expect(page.getByTestId('voice-alert')).toContainText('Voice isn’t available right now', {
    timeout: 20_000,
  })
  await expect(page.getByTestId('voice-alert').getByRole('button', { name: 'Close' })).toBeVisible()
  await audit(page)
  await page.getByLabel('Message', { exact: true }).fill('name: Still Typing Cafe')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByTestId('shop-so-far')).toContainText('Still Typing Cafe')
})

const LOCALES = [
  'en',
  'hi',
  'bn',
  'te',
  'mr',
  'kn',
  'zh-Hans',
  'ms',
  'ta',
  'ja',
  'ko',
  'id',
  'th',
  'vi',
  'fil',
]
for (const locale of LOCALES) {
  test(`voice-mode alert and controls in ${locale}`, async ({ page }, info) => {
    test.skip(info.project.name !== 'phone', 'Language coverage runs on the phone')
    await blockedMicrophone(page)
    await enter(page)
    const copy = await page.evaluate(async (locale) => {
      // Through Vite, so the browser modules stay out of the Node test compilation.
      const flow = (await import('/src/features/v1/newShopCopy.ts' as string)) as {
        newShopCopyFor: (l: string) => { begin: string }
      }
      const voice = (await import('/src/features/v1/voiceModeCopy.ts' as string)) as {
        voiceModeCopyFor: (l: string) => Record<string, string>
      }
      const app = (await import('/src/features/v1/strings.ts' as string)) as {
        en: { addShop: string; continuePreview: string }
      }
      const translations = (await import('/src/features/v1/locales/index.ts' as string)) as {
        translations: Record<string, { addShop: string; continuePreview: string }>
      }
      const { addShop, continuePreview } =
        locale === 'en' ? app.en : translations.translations[locale]!
      return {
        ...voice.voiceModeCopyFor(locale),
        begin: flow.newShopCopyFor(locale).begin,
        addShop,
        continuePreview,
      } as Record<string, string>
    }, locale)
    await page.evaluate((language) => {
      localStorage.setItem('niva.starter.preferences', JSON.stringify({ language }))
    }, locale)
    await page.reload()
    await page.getByRole('button', { name: copy.continuePreview! }).click()
    await page.getByRole('banner').getByRole('button', { name: copy.addShop! }).click()
    await page.getByRole('button', { name: copy.begin! }).click()
    const alert = page.getByTestId('voice-alert')
    await expect(alert).toContainText(copy.micBlockedTitle!)
    await expect(alert).toContainText(copy.micBlockedBody!)
    await expect(alert.getByRole('button', { name: copy.tryAgain! })).toBeVisible()
    await expect(alert.getByRole('button', { name: copy.typeInstead! })).toBeVisible()
    await expect(alert.getByRole('button', { name: copy.close! })).toBeVisible()
    if (locale !== 'en') expect(copy.micBlockedTitle!).not.toBe('Your microphone is blocked')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    )
    if (['hi', 'ja', 'ta'].includes(locale)) await audit(page)
  })
}
