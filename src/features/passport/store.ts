import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { components } from '../../api/generated'
import { useCustomer } from '../customer/account'
import { useRewards } from '../rewards/storage'

type Schemas = components['schemas']
export type PassportView = Schemas['PassportView']
export type StampResult = Schemas['StampResult']
export type Outcome = Schemas['Outcome']
export type Quest = Schemas['Quest']
export type Requirement = Schemas['Requirement']
export type Board = Schemas['Board']
export type LevelKey = PassportView['level']['key']

/**
 * The passport on the client. Signed in: the server's passport. Signed out: drawn by the server
 * from this phone's signed visit receipts ("on this phone"), which merge once on sign-in.
 */
const RECEIPTS = 'chalkboard.passport.receipts.v1'
const change = 'chalkboard-passport-change'
const MAX_RECEIPTS = 60

type State = {
  view: PassportView | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  key: string
}
let state: State = { view: null, status: 'idle', key: '' }
// Only the latest load lands: a stamp changes the receipts and this phone's card a moment
// apart, and an older answer must not overwrite the newer count.
let loads = 0
const listeners = new Set<() => void>()
function emit(next: Partial<State>) {
  state = { ...state, ...next }
  listeners.forEach((listener) => listener())
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function receipts(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECEIPTS) || '[]')
    return Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string').slice(-MAX_RECEIPTS)
      : []
  } catch {
    return []
  }
}
export function keepReceipt(receipt: string) {
  try {
    const list = [...receipts().filter((r) => r !== receipt), receipt].slice(-MAX_RECEIPTS)
    localStorage.setItem(RECEIPTS, JSON.stringify(list))
  } catch {
    /* The stamp still shows; it just can't be kept on this phone. */
  }
  window.dispatchEvent(new Event(change))
}
function clearReceipts() {
  try {
    localStorage.removeItem(RECEIPTS)
  } catch {
    /* Nothing to clear. */
  }
}

/** The phone's own timezone and, when known, where the person is browsing. */
export function where(place?: { lat: number; lng: number } | null) {
  const params = new URLSearchParams({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone })
  if (place) {
    params.set('lat', place.lat.toFixed(5))
    params.set('lng', place.lng.toFixed(5))
  }
  return params.toString()
}

export function setPassport(view: PassportView) {
  const safe = safePassport(view)
  if (safe) emit({ view: safe, status: 'ready' })
}

function safePassport(value: unknown): PassportView | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Partial<PassportView>
  if (
    !row.level ||
    typeof row.level !== 'object' ||
    !row.streak ||
    typeof row.streak !== 'object' ||
    !row.impact ||
    typeof row.impact !== 'object'
  )
    return null
  const records = (items: unknown) =>
    Array.isArray(items) ? items.filter((item) => item && typeof item === 'object') : []
  const perks = records(row.perks).filter(
    (item) => typeof item.text === 'string' && typeof item.shop_name === 'string',
  )
  const shops = records(row.shops).filter(
    (item) => typeof item.name === 'string' && typeof item.id === 'string',
  )
  const quests = records(row.quests)
    .filter((item) => typeof item.id === 'string' && typeof item.kind === 'string')
    .map((item) => ({
      ...item,
      stops: Array.isArray(item.stops)
        ? item.stops.filter(
            (stop: unknown) =>
              !!stop && typeof stop === 'object' && 'name' in stop && typeof stop.name === 'string',
          )
        : [],
    }))
  const impact = row.impact as PassportView['impact']
  return {
    ...row,
    stamps: records(row.stamps).filter(
      (item) => typeof item.shop_id === 'string' && typeof item.kind === 'string',
    ) as PassportView['stamps'],
    shops: shops as PassportView['shops'],
    areas: records(row.areas).filter(
      (item) => typeof item.id === 'string' && typeof item.name === 'string',
    ) as PassportView['areas'],
    quests: quests as PassportView['quests'],
    perks: perks as PassportView['perks'],
    impact: {
      ...impact,
      saved: impact.saved && typeof impact.saved === 'object' ? impact.saved : {},
    },
  } as PassportView
}

type Api = ReturnType<typeof useCustomer>['api']

async function load(api: Api, signedIn: boolean, cards: Record<string, number>, query: string) {
  const pending = receipts()
  if (signedIn) {
    if (pending.length || Object.keys(cards).length) {
      // Once, on sign-in: this phone's verified visits move into the account.
      const view = await api<PassportView>(`/api/v1/customer/passport/merge?${query}`, {
        method: 'POST',
        body: JSON.stringify({ receipts: pending, cards }),
      })
      clearReceipts()
      return safePassport(view) ?? Promise.reject(new Error('Invalid passport response'))
    }
    return api<PassportView>(`/api/v1/customer/passport?${query}`).then((view) => {
      const safe = safePassport(view)
      if (!safe) throw new Error('Invalid passport response')
      return safe
    })
  }
  return api<PassportView>(`/api/v1/public/passport/preview?${query}`, {
    method: 'POST',
    body: JSON.stringify({ receipts: pending, cards }),
  }).then((view) => {
    const safe = safePassport(view)
    if (!safe) throw new Error('Invalid passport response')
    return safe
  })
}

/** Loads (and keeps fresh) the passport for the current account state. */
export function usePassport(place?: { lat: number; lng: number } | null) {
  const account = useCustomer()
  const { data } = useRewards()
  const current = useSyncExternalStore(subscribe, () => state)
  const signedIn = account.status === 'signed-in'
  const query = where(place)
  const cards = signedIn
    ? {}
    : Object.fromEntries(
        // Every card on this phone, empty ones too: a reward claimed here resets the passport.
        Object.entries(data.shops).map(([id, card]) => [id, card.stamps]),
      )
  const cardKey = JSON.stringify(cards)
  const key = `${account.status}|${query}|${cardKey}`
  const refresh = useCallback(() => {
    if (account.status === 'loading') return
    const ticket = ++loads
    emit({ status: 'loading', key })
    load(account.api, signedIn, JSON.parse(cardKey) as Record<string, number>, query)
      .then((view) => ticket === loads && emit({ view, status: 'ready' }))
      .catch(() => ticket === loads && emit({ status: 'error' }))
  }, [account.api, account.status, signedIn, cardKey, query, key])
  useEffect(() => {
    if (state.key !== key) refresh()
  }, [key, refresh])
  useEffect(() => {
    const again = () => refresh()
    window.addEventListener(change, again)
    return () => window.removeEventListener(change, again)
  }, [refresh])
  return { ...current, refresh, signedIn }
}

/** The demo QR flow: demo shops show their QR on screen, so this fetches the demo key. */
export async function demoKey(shop: string): Promise<string> {
  const response = await fetch(`/api/v1/public/shops/${encodeURIComponent(shop)}/demo-qr`)
  if (!response.ok) throw new Error(String(response.status))
  return ((await response.json()) as { key: string }).key
}
