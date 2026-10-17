import { expect, test, type Page, type WebSocket } from '@playwright/test'
import { FIRST_QUESTION } from './newShopTopics.js'
import { enter, localOnly } from './stories/support.js'

// Owner decision (17 Oct): voice must survive a bad network ("I cannot afford this feature not
// to work"). Production logs showed the socket closing from a phone network drop. The phone's
// network is throttled and cut with Chrome's own network emulation (CDP); the conversation comes
// back silently on the same session, the answer given while offline is not lost, nothing is
// asked again and only one socket stays open.
test.use({ reducedMotion: 'reduce', viewport: { width: 390, height: 844 }, hasTouch: true })
test.beforeEach(async ({ page }) => {
  await localOnly(page)
})

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

type Voice = { sockets: WebSocket[]; closed: Set<WebSocket>; ready: string[] }

function watchVoice(page: Page): Voice {
  const voice: Voice = { sockets: [], closed: new Set(), ready: [] }
  page.on('websocket', (socket) => {
    if (!socket.url().includes('/api/v1/voice')) return
    voice.sockets.push(socket)
    socket.on('close', () => voice.closed.add(socket))
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string' || !payload.includes('"ready"')) return
      const event = JSON.parse(payload) as { kind: string; session_id?: string }
      if (event.kind === 'ready' && event.session_id) voice.ready.push(event.session_id)
    })
  })
  return voice
}

/** A poor mobile connection: 400 ms each way, about 512 kbit/s up and down. */
const SLOW = { offline: false, latency: 400, downloadThroughput: 64_000, uploadThroughput: 64_000 }

async function setVisible(page: Page, visible: boolean) {
  await page.evaluate((shown) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (shown ? 'visible' : 'hidden'),
    })
    document.dispatchEvent(new Event('visibilitychange'))
  }, visible)
}

async function typeTurn(page: Page, text: string) {
  await page.getByLabel('Message', { exact: true }).fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

test('a throttled, dropped and backgrounded network: voice resumes silently, nothing lost or asked twice', async ({
  page,
}) => {
  test.setTimeout(150_000)
  await quietMicrophone(page)
  const voice = watchVoice(page)
  const network = await page.context().newCDPSession(page)
  await network.send('Network.enable')
  const slow = () => network.send('Network.emulateNetworkConditions', SLOW)
  /** The phone loses its network (and gets the slow one back). */
  const offline = async (lost: boolean) => {
    await page.context().setOffline(lost)
    if (!lost) await slow()
    expect(await page.evaluate(() => navigator.onLine)).toBe(!lost)
  }

  await enter(page)
  await page.getByRole('banner').getByRole('button', { name: 'Add shop details' }).click()
  await page.getByRole('button', { name: 'Let’s begin' }).click()
  const log = page.getByRole('log')
  const orb = page.getByTestId('voice-orb').first()
  const card = page.getByTestId('shop-so-far')
  await expect(log).toContainText(FIRST_QUESTION, { timeout: 20_000 })
  await expect(orb).toHaveAttribute('data-phase', 'listening', { timeout: 20_000 })
  const session = voice.ready[0]
  expect(session).toBeTruthy()
  // The owner types while voice stays on (the same live session).
  await page.getByRole('button', { name: 'Type instead' }).click()

  // A slow network: the conversation carries on.
  await slow()
  await typeTurn(page, 'name: Courtyard Chai; category: Tea stall')
  await expect(card).toContainText('Courtyard Chai', { timeout: 30_000 })

  // The network drops. The owner answers anyway; the answer waits for the session.
  await offline(true)
  await expect(orb).toHaveAttribute('data-phase', 'reconnecting')
  await typeTurn(page, 'location: Indiranagar')
  await page.waitForTimeout(5_000)
  expect(voice.sockets).toHaveLength(1)

  // Back online (still slow): the same session, silently, and the answer reaches the coach.
  await offline(false)
  await expect(card).toContainText('Indiranagar', { timeout: 40_000 })
  await expect(orb).toHaveAttribute('data-phase', 'listening', { timeout: 20_000 })
  expect(voice.sockets.length).toBeGreaterThan(1)
  expect(new URL(voice.sockets.at(-1)!.url()).searchParams.get('session_id')).toBe(session)
  expect(voice.ready.every((id) => id === session)).toBe(true)

  // The app goes to the background and the network drops: nothing is tried in the background.
  await setVisible(page, false)
  await offline(true)
  await expect.poll(() => voice.closed.size, { timeout: 10_000 }).toBe(voice.sockets.length)
  await offline(false)
  const before = voice.sockets.length
  await page.waitForTimeout(3_000)
  expect(voice.sockets).toHaveLength(before)
  // Back in the foreground: the conversation comes back on the same session.
  await setVisible(page, true)
  await expect(orb).toHaveAttribute('data-phase', 'listening', { timeout: 40_000 })
  expect(voice.sockets.length).toBe(before + 1)
  expect(voice.ready.at(-1)).toBe(session)

  // No greeting again, no answered question asked again, one open socket, no error alert.
  const said = (await log.innerText()).split(FIRST_QUESTION).length - 1
  expect(said).toBe(1)
  await expect(card).toContainText('Courtyard Chai')
  await expect(card).toContainText('Indiranagar')
  await expect.poll(() => voice.sockets.length - voice.closed.size).toBe(1)
  await expect(page.getByRole('alert')).toHaveCount(0)
})
