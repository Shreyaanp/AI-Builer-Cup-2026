/**
 * One history model for both apps, so the phone's Back, iOS swipe-back and in-app back
 * buttons behave like an app. Every entry carries a key and its position in the stack:
 * screens keep what the URL does not hold (scroll, a conversation shown) per entry, so Back,
 * Forward and a refresh return to the same place. Sheets and dialogs push their own
 * same-URL entries through the back stack (features/v1/backStack.ts), on top of this.
 *
 * Every pushState/replaceState in the app goes through pushEntry/replaceEntry.
 */
export interface EntryState {
  /** Names this entry's sessionStorage (readEntry/writeEntry). */
  key?: string
  /** Position in this tab's history; tells Back from Forward. */
  idx?: number
  /** The address this entry was opened from (in-app back links). */
  from?: string
  scrollY?: number
  /** Opened from inside the customer app: its back button can go back in history. */
  inApp?: boolean
  [field: string]: unknown
}

const PREFIX = 'chalkboard.entry.'
// The newest entries' stored state is kept; older ones are dropped.
const MAX_STORED = 30

let position = 0
let direction: -1 | 0 | 1 = 0
let installed = false

const newKey = () => Math.random().toString(36).slice(2, 10)

export function entryState(): EntryState {
  return (history.state as EntryState | null) ?? {}
}

/**
 * Stamp the current entry and follow Back/Forward. Runs once, before the app renders (its
 * popstate listener must come first). Returns true when this load is a fresh visit: not a
 * refresh and not Back/Forward from another site, so a deep link can get a back target.
 */
export function installHistory(): boolean {
  const current = entryState()
  const fresh = current.key === undefined
  if (fresh) history.replaceState({ ...current, key: newKey(), idx: 0 }, '')
  position = entryState().idx ?? 0
  if (installed) return fresh
  installed = true
  window.addEventListener(
    'popstate',
    () => {
      const idx = entryState().idx
      // An entry this tab never stamped (from before this model) counts as Back.
      direction = idx === undefined ? -1 : idx > position ? 1 : idx < position ? -1 : 0
      if (idx !== undefined) position = idx
    },
    true,
  )
  // A refresh or a switch away keeps the scroll of the entry on screen.
  window.addEventListener('pagehide', saveScroll)
  return fresh
}

/** The last history move: -1 Back, 1 Forward, 0 an in-app push. */
export function lastDirection() {
  return direction
}

/** Fields an entry hands on to the next one (never its own key, position or scroll). */
export function carried(): EntryState {
  const rest = { ...entryState() }
  for (const own of ['key', 'idx', 'from', 'scrollY', 'sheet']) delete rest[own]
  return rest
}

/** A new history entry (a screen, a tab, a sheet); the current one keeps its scroll. */
export function pushEntry(url: string | URL | null = null, state: EntryState = {}) {
  saveScroll()
  position += 1
  direction = 0
  history.pushState(
    { ...state, key: newKey(), idx: position, from: location.href },
    '',
    url ?? undefined,
  )
}

/** Change the current entry's address or fields; its key and position stay. */
export function replaceEntry(url: string | URL | null = null, patch: EntryState = {}) {
  history.replaceState({ ...entryState(), ...patch }, '', url ?? undefined)
}

export function saveScroll() {
  replaceEntry(null, { scrollY: window.scrollY })
}

/**
 * Scroll back to where an entry was. Content can still be loading, so it tries again for a
 * few frames until the page is long enough.
 */
export function restoreScroll(y = entryState().scrollY ?? 0, frames = 12) {
  let count = 0
  const attempt = () => {
    window.scrollTo({ top: y, behavior: 'instant' })
    if (Math.abs(window.scrollY - y) > 5 && count++ < frames) requestAnimationFrame(attempt)
  }
  requestAnimationFrame(attempt)
}

/**
 * A link opened from outside (a shared shop, a QR stamp, a tab) gets the app's own page
 * beneath it, so Back lands in the app instead of leaving it or showing a blank page.
 */
export function seedBackTarget(parent: string | null) {
  const here = location.pathname + location.search + location.hash
  if (!parent || parent === here) return
  history.replaceState({ key: newKey(), idx: 0 }, '', parent)
  position = 1
  history.pushState({ key: newKey(), idx: 1, inApp: true, from: location.href }, '', here)
}

/** State kept for this history entry only (this tab), e.g. a conversation shown on it. */
export function readEntry<T>(name: string): T | null {
  const key = entryState().key
  if (!key) return null
  try {
    const value = sessionStorage.getItem(`${PREFIX}${key}.${name}`)
    return value === null ? null : (JSON.parse(value) as T)
  } catch {
    return null
  }
}

export function writeEntry(name: string, value: unknown) {
  const key = entryState().key
  if (!key) return
  try {
    const order = (JSON.parse(sessionStorage.getItem(`${PREFIX}order`) || '[]') as string[])
      .filter((item) => item !== key)
      .concat(key)
    for (const old of order.splice(0, Math.max(0, order.length - MAX_STORED)))
      for (const item of Object.keys(sessionStorage))
        if (item.startsWith(`${PREFIX}${old}.`)) sessionStorage.removeItem(item)
    sessionStorage.setItem(`${PREFIX}order`, JSON.stringify(order))
    sessionStorage.setItem(`${PREFIX}${key}.${name}`, JSON.stringify(value))
  } catch {
    /* Optional storage: the screen still works for this visit. */
  }
}
