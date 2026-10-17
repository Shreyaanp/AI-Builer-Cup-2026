import type { MouseEvent } from 'react'
import { entryState, pushEntry } from '../../app/history'

export function subscribePath(listener: () => void) {
  window.addEventListener('popstate', listener)
  return () => window.removeEventListener('popstate', listener)
}
export function currentPath() {
  return location.pathname
}

/**
 * Run a DOM update inside a view transition when the browser has them and motion is on. A
 * transition that is skipped (a second tap starts another, or the update is slow) rejects its
 * promises; that is expected, so it must not surface as an unhandled rejection.
 *
 * `direction` picks the page motion (customer.css): forward pushes the new page in from the
 * end edge, back slides it in from the start edge, a tab switch only cross-fades.
 */
export function viewTransition(
  update: () => void | Promise<void>,
  direction: 'forward' | 'back' | 'tab' = 'forward',
) {
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    void update()
    return
  }
  const root = document.documentElement
  root.dataset.nav = direction
  const transition = document.startViewTransition(update)
  transition.ready.catch(() => undefined)
  transition.finished
    .catch(() => undefined)
    .finally(() => {
      if (root.dataset.nav === direction) delete root.dataset.nav
    })
}

/** Keep native modified clicks; ordinary links support back/forward and shared hero snapshots. */
export function customerNavigate(event: MouseEvent<HTMLElement>) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return
  if (!(event.currentTarget instanceof HTMLAnchorElement)) return
  const url = new URL(event.currentTarget.href)
  if (url.origin !== location.origin) return
  event.preventDefault()
  // The page already on screen (a tab tapped again) is not a new step: back to its top.
  if (url.href === location.href && !url.hash) {
    window.scrollTo({ top: 0, behavior: 'smooth' })
    return
  }
  const update = () => {
    // Marks an in-app step, so "back" can return to the exact place it came from.
    pushEntry(url.pathname + url.search + url.hash, { inApp: true })
    dispatchEvent(new PopStateEvent('popstate'))
    window.scrollTo({ top: 0, behavior: 'instant' })
    if (url.hash)
      requestAnimationFrame(() =>
        document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView(),
      )
  }
  // The navigation bar switches tabs: a cross-fade, no push.
  viewTransition(update, event.currentTarget.closest('.c-nav') ? 'tab' : 'forward')
}

/**
 * Back from a shop or a chat: when the customer came from inside the app (the conversation, a
 * list), go back in history so the page restores where they were; a shared link opens the
 * link's own target instead.
 */
export function customerBack(event: MouseEvent<HTMLElement>) {
  if (entryState().inApp && event.button === 0) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    viewTransition(
      () =>
        new Promise<void>((resolve) => {
          addEventListener('popstate', () => requestAnimationFrame(() => resolve()), {
            once: true,
          })
          history.back()
        }),
      'back',
    )
    return
  }
  customerNavigate(event)
}

/** Navigate in the customer app without a click (a spoken command), keeping back/forward. */
export function goTo(path: string) {
  pushEntry(path, { inApp: true })
  dispatchEvent(new PopStateEvent('popstate'))
  window.scrollTo({ top: 0, behavior: 'instant' })
}
