import { goTo, viewTransition } from '../frontdoors/navigation'

export const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

export function chatPath(shop: string, thread: string) {
  return `/explore/chats/${encodeURIComponent(shop)}/${encodeURIComponent(thread)}`
}

/**
 * Go to a path with the shared-element transition the rest of the customer app uses. An
 * in-app step like a link: back returns to the exact place it came from.
 */
export function go(path: string) {
  viewTransition(() => goTo(path))
}
