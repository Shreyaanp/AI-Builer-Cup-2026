export type AppKind = 'landing' | 'customer' | 'business'

/** The only host/path policy. Overrides also make local browser tests explicit. */
export function resolveApp(url: URL): AppKind {
  const override = url.searchParams.get('app')
  if (override === 'landing' || override === 'customer' || override === 'business') return override
  if (url.hostname === 'business.chalkboard.shreyaan.work' || url.hostname.endsWith('.run.app'))
    return 'business'
  if (/^\/(explore(?:\/|$)|discover\/?$|s\/)/.test(url.pathname)) return 'customer'
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return 'business'
  return 'landing'
}

export function canonicalCustomerPath(path: string): string {
  // The old list link opens the list; /explore/ itself is the AI-first front door.
  if (/^\/discover\/?$/.test(path)) return '/explore/browse'
  if (path.startsWith('/s/')) return '/explore' + path
  return path
}

/**
 * Where Back goes from a page opened straight from a link (shared shop, QR stamp, a tab):
 * the screen it belongs under in the app. Null for the app's start screen.
 */
export function backTarget(url: URL, app: AppKind): string | null {
  const keep = new URLSearchParams()
  const override = url.searchParams.get('app')
  if (override) keep.set('app', override)
  const query = keep.size ? `?${keep}` : ''
  const path = url.pathname
  if (app === 'customer') {
    if (/^\/explore\/chats\/[^/]+\/[^/]+\/?$/.test(path)) return `/explore/chats${query}`
    // A list link (/explore?category=…) is the Browse page, not the start screen.
    const filtered = [...url.searchParams.keys()].some((key) => key !== 'app')
    return /^\/explore\/?$/.test(path) && !filtered ? null : `/explore/${query}`
  }
  if (app !== 'business') return null
  const tab = url.searchParams.get('tab')
  if (path === '/new-shop') return `/${query}`
  if (path !== '/' || !tab) return null
  const parent = { google: 'grow', privacy: 'you' }[tab]
  if (parent) keep.set('tab', parent)
  return `/${keep.size ? `?${keep}` : ''}`
}

export function customerShopLink(id: string, origin: string): string {
  return `${origin}/explore/s/${encodeURIComponent(id)}`
}

/** Public configuration only; never infer the customer origin from the owner host. */
export function safeCustomerOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    if (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
    )
      return url.origin
  } catch {
    /* Invalid public configuration disables sharing links. */
  }
  return null
}
