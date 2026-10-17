type AnalyticsParam = string | number | boolean
type AnalyticsEvent =
  | 'page_view'
  | 'onboarding_started'
  | 'voice_used'
  | 'stop_said'
  | 'shop_live'
  | 'face_check_result'
  | 'customer_first_open'
  | 'ask_sent'
  | 'results_shown'
  | 'shop_opened'
  | 'follow'
  | 'qr_scanned'
  | 'stamp_added'
  | 'purchase_orders_opened'
  | 'pos_import_done'

type Gtag = (...args: unknown[]) => void
declare global {
  interface Window {
    dataLayer?: unknown[]
    gtag?: Gtag
  }
}

let measurementId = ''
let accepted = false
let loaded = false
let currentApp: 'owner' | 'customer' = 'owner'
let currentRegion: 'IN' | 'SG' = 'IN'

export function configureAnalytics(
  id: string,
  hasConsent: boolean,
  app: 'owner' | 'customer',
  region: 'IN' | 'SG',
) {
  measurementId = id.trim()
  accepted = accepted || hasConsent
  currentApp = app
  currentRegion = region
  if (!measurementId || !accepted || typeof window === 'undefined') return

  if (!window.gtag) {
    window.dataLayer = window.dataLayer || []
    window.gtag = (...args: unknown[]) => window.dataLayer!.push(args)
    window.gtag('consent', 'default', {
      analytics_storage: 'granted',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    })
    const script = document.createElement('script')
    script.async = true
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`
    document.head.append(script)
    window.gtag('js', new Date())
    window.gtag('config', measurementId, { send_page_view: false })
    loaded = true
  }
  window.gtag('consent', 'update', {
    analytics_storage: 'granted',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
  })
  window.gtag('set', 'user_properties', { app: currentApp, region: currentRegion })
}

export function setAnalyticsConsent(hasConsent: boolean) {
  accepted = hasConsent
  if (hasConsent) {
    trackedPath = ''
    configureAnalytics(measurementId, true, currentApp, currentRegion)
  } else if (window.gtag) {
    window.gtag('consent', 'update', {
      analytics_storage: 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    })
  }
  if (hasConsent) trackCurrentPage()
}

const allowedParams: Record<AnalyticsEvent, readonly string[]> = {
  page_view: ['page_path'],
  onboarding_started: [],
  voice_used: [],
  stop_said: [],
  shop_live: ['shop_kind', 'region'],
  face_check_result: ['result'],
  customer_first_open: ['region'],
  ask_sent: [],
  results_shown: [],
  shop_opened: ['shop_kind', 'region'],
  follow: ['shop_kind', 'region'],
  qr_scanned: ['shop_kind', 'region'],
  stamp_added: ['shop_kind', 'region'],
  purchase_orders_opened: [],
  pos_import_done: ['rows'],
}

export function track(event: AnalyticsEvent, params: Record<string, AnalyticsParam> = {}) {
  if (!measurementId || !accepted || !loaded || !window.gtag) return
  const safe = Object.fromEntries(
    Object.entries(params).filter(([key, value]) => {
      if (!allowedParams[event].includes(key)) return false
      if (key === 'region') return value === 'IN' || value === 'SG'
      if (key === 'shop_kind')
        return ['grocery', 'tea', 'bakery', 'restaurant', 'other'].includes(String(value))
      if (key === 'result')
        return ['verified', 'in_review', 'retry', 'unavailable'].includes(String(value))
      if (key === 'rows') return typeof value === 'number' && Number.isFinite(value) && value >= 0
      if (key === 'page_path')
        return typeof value === 'string' && value.startsWith('/') && !value.includes('?')
      return false
    }),
  )
  if (event === 'page_view') {
    const path = String(safe.page_path ?? '/')
    safe.page_location = `${location.origin}${path}`
    safe.page_referrer = location.origin
    safe.page_title = 'Chalkboard'
  }
  window.gtag('event', event, safe)
}

let trackedPath = ''
export function trackCurrentPage() {
  if (typeof window === 'undefined') return
  const path = location.pathname
  if (path === trackedPath) return
  trackedPath = path
  const pagePath = path.replace(/\/(?:[0-9a-f-]{36}|demo-[a-z0-9-]+)(?=\/|$)/gi, '/:id')
  track('page_view', { page_path: pagePath })
}

export function watchRouteChanges() {
  const notify = () => trackCurrentPage()
  addEventListener('popstate', notify)
  const push = history.pushState.bind(history)
  const replace = history.replaceState.bind(history)
  history.pushState = function (...args) {
    push(...args)
    notify()
  }
  history.replaceState = function (...args) {
    replace(...args)
    notify()
  }
  notify()
  return () => {
    removeEventListener('popstate', notify)
    history.pushState = push
    history.replaceState = replace
  }
}
