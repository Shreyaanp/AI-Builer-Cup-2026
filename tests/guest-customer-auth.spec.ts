import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'

test('Google upgrade links the guest, refreshes claims and preserves identity on collision', async ({
  page,
}) => {
  await page.route('**/*', (route) =>
    ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
      ? route.fallback()
      : route.abort(),
  )
  await page.route('**/__guest-upgrade-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Upgrade fixture</title>
        <script type="importmap">{"imports":{"firebase/auth":"/node_modules/.vite/deps/firebase_auth.js"}}</script>`,
    }),
  )
  const source = readFileSync(new URL('../src/auth/upgradeGoogle.ts', import.meta.url), 'utf8')
  const compiled = transpileModule(source, {
    compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ESNext },
  }).outputText
  await page.route('**/src/auth/upgradeGoogle.ts', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: compiled }),
  )
  await page.goto('/__guest-upgrade-test')
  // Substitute only the provider SDK; exercise the real upgrade helper without OAuth.
  await page.route('**/node_modules/.vite/deps/firebase_auth.js*', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `
        export class GoogleAuthProvider {}
        export async function linkWithPopup(user) {
          window.upgradeCalls.push('link:' + user.uid)
          if (window.upgradeCollision) throw new Error('auth/credential-already-in-use')
          user.isAnonymous = false
        }
        export async function signInWithPopup() { window.upgradeCalls.push('signIn') }
      `,
    }),
  )
  const result = await page.evaluate(async () => {
    const fixture = window as typeof window & {
      upgradeCalls: string[]
      upgradeCollision: boolean
    }
    fixture.upgradeCalls = []
    fixture.upgradeCollision = false
    const path = '/src/auth/upgradeGoogle.ts'
    const { upgradeGoogle } = await import(/* @vite-ignore */ path)
    const guest = {
      uid: 'fixture-guest',
      isAnonymous: true,
      async getIdToken(force: boolean) {
        fixture.upgradeCalls.push('refresh:' + force)
      },
    }
    const auth = { currentUser: guest }
    await upgradeGoogle(auth)
    const linked = { same: auth.currentUser === guest, calls: [...fixture.upgradeCalls] }
    fixture.upgradeCalls = []
    fixture.upgradeCollision = true
    guest.isAnonymous = true
    let rejected = false
    try {
      await upgradeGoogle(auth)
    } catch {
      rejected = true
    }
    const collision = {
      rejected,
      same: auth.currentUser === guest,
      anonymous: guest.isAnonymous,
      calls: [...fixture.upgradeCalls],
    }
    fixture.upgradeCalls = []
    guest.isAnonymous = false
    await upgradeGoogle(auth)
    return { linked, collision, signedInCalls: fixture.upgradeCalls }
  })
  expect(result).toEqual({
    linked: { same: true, calls: ['link:fixture-guest', 'refresh:true'] },
    collision: {
      rejected: true,
      same: true,
      anonymous: true,
      calls: ['link:fixture-guest'],
    },
    signedInCalls: ['signIn'],
  })
})
